// What a batch of new mail says to the phone. Pure: the rows in, the pushes
// out, so the decision is one function the tests can hold still. The same
// rules the desktop banner runs (@mail/shared/src/lib/notifications) decide
// what is worth an interruption; this only shapes the result for a push.

import type { PushMessage } from "@platform/push/transports";
import {
  notificationContent,
  previewWantsSummary,
  shouldNotify,
  type NotificationPrefs,
  type NotifyContext,
} from "@mail/shared/src/lib/notifications";
import { participantsLine } from "@mail/shared/src/lib/format";
import type { Thread } from "@mail/shared/src/store/types";
import type { Sender } from "@mail/shared/src/lib/sendAs";

/** Mail older than this is not "new": a backfill, or a catch-up after a
 *  long time offline, never buzzes the phone once per message. */
export const FRESH_MS = 15 * 60 * 1000;

/** How often a waiting push looks again. */
export const PUSH_POLL_MS = 1000;


/** Past this many pushable threads in one batch, the phone gets one line
 *  naming them instead of a buzz per thread. */
export const SOLO_LIMIT = 3;

/** What one push is about, for the phone to open and for the tests to read. */
export type MailPushData = {
  kind: "mail";
  thread_id: string;
  thread_gmail_id: string;
  account_id: string;
};

export type PlanInput = {
  threads: Thread[];
  prefs: NotificationPrefs;
  me?: Sender;
  clusters?: NotifyContext["clusters"];
  /** The person's wall clock, for quiet hours. */
  now: Date;
  /** The model's summary per thread gmail id, for the push body. */
  summaries?: Record<string, string>;
};

/** The wall clock in a time zone, as a Date whose local getters answer in
 *  that zone. Quiet hours are set in the person's own hours, and the server
 *  keeps none. An unknown zone falls back to the runtime's clock. */
export function wallClock(now: Date, timeZone?: string): Date {
  if (!timeZone) return now;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return new Date(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  } catch {
    return now;
  }
}

/** The threads whose push would read better with the model's summary and
 *  does not have one yet: solo pushes at full preview. */
export function pushesWantingSummary(input: PlanInput, pushes: PushMessage[]): string[] {
  if (!previewWantsSummary(input.prefs.preview)) return [];
  return pushes
    .map((p) => (p.data as Partial<MailPushData> | undefined)?.thread_gmail_id)
    .filter((id): id is string => !!id && !input.summaries?.[id]);
}

/** The pushes a batch of new mail earns: one per thread the rules let
 *  through, or one digest past `SOLO_LIMIT`. Nothing when nothing passes. */
export function newMailPushes(input: PlanInput): PushMessage[] {
  const passing = input.threads.filter(
    (t) =>
      shouldNotify(t, {
        prefs: input.prefs,
        me: input.me,
        now: input.now,
        clusters: input.clusters,
        assumeNew: true,
      }).notify,
  );
  if (passing.length === 0) return [];
  const sound = input.prefs.sound ? "default" : undefined;
  const data = (t: Thread): MailPushData => ({ kind: "mail", thread_id: t._id, thread_gmail_id: t.gmail_id, account_id: t.account_id });
  if (passing.length <= SOLO_LIMIT) {
    return passing.map((t) => {
      const content = notificationContent(t, {
        preview: input.prefs.preview,
        senderLine: participantsLine(t, input.me),
        summary: input.summaries?.[t.gmail_id],
      });
      // Do not send `time-sensitive`: the iOS binary has no Time Sensitive
      // Notifications entitlement, and iOS drops those rather than showing
      // them as ordinary banners.
      // content-available wakes the phone app so it can fetch the mail before
      // the person taps; a digest names no thread, so it does not.
      return { ...content, data: data(t), sound, priority: "high", ttlSeconds: 60 * 60, contentAvailable: true };
    });
  }
  const names = [...new Set(passing.map((t) => participantsLine(t, input.me)).filter(Boolean))];
  const body =
    input.prefs.preview === "none" ? "Open Whisk to read them." : names.slice(0, 4).join(", ") + (names.length > 4 ? ` and ${names.length - 4} more` : "");
  return [{ title: `${passing.length} new messages`, body, data: { kind: "mail-digest", account_id: passing[0].account_id }, sound, priority: "high", ttlSeconds: 60 * 60 }];
}

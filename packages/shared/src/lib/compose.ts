import type { Address, ComposeMode, Message, OutgoingAttachment } from "../store/types";
import { forwardedAttachments } from "./attachments";
import { answeredAs, isOwnAddress, type Sender } from "./sendAs";

// How a reply, reply-all or forward is seeded from the thread it answers.
// One function for every client (web compose, mobile, the CLI) so they
// never disagree about who a reply goes to or what a forward quotes.

export type ComposeSeed = {
  /** The address it goes out from, when the answered mail named one of mine. */
  from?: string;
  to: Address[];
  subject: string;
  body_text: string;
  thread_gmail_id?: string;
  reply_to_gmail_id?: string;
  attachments?: OutgoingAttachment[];
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Recipients as people type them: "Ada Lovelace <ada@x.org>, grace@y.org;
 *  bob@z.io". Commas and semicolons separate; whatever is not an address
 *  comes back in `invalid` for the caller to drop or refuse. */
export function parseAddresses(raw: string): { addresses: Address[]; invalid: string[] } {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[,;]/)) {
    const text = part.trim();
    if (!text) continue;
    const named = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(text);
    const email = (named ? named[2] : text).trim().toLowerCase();
    if (!EMAIL.test(email)) {
      invalid.push(text);
      continue;
    }
    const name = named?.[1]?.trim();
    addresses.push(name ? { name, email } : { email });
  }
  return { addresses, invalid };
}

/** A recipient list with more added, each address once. */
export function addRecipients(list: readonly Address[], added: readonly Address[]): Address[] {
  const seen = new Set(list.map((a) => a.email));
  const fresh = added.filter((a) => !seen.has(a.email) && seen.add(a.email));
  return fresh.length ? [...list, ...fresh] : (list as Address[]);
}

/** What a composer calls itself: a panel's title, and the verb before the
 *  recipients when it sits inside the thread. */
export function composeLabels(mode: ComposeMode): { title: string; verb: string } {
  if (mode === "new") return { title: "New message", verb: "To" };
  if (mode === "forward") return { title: "Forward", verb: "Forward to" };
  return { title: "Reply", verb: mode === "replyAll" ? "Reply all to" : "Reply to" };
}

/** The message a reply answers: the newest one not from me, else the newest. */
export function replyTarget(messages: readonly Message[], me?: Sender): Message | undefined {
  return (
    [...messages].reverse().find((m) => !me || !isOwnAddress(me, m.from.email)) ?? messages[messages.length - 1]
  );
}

export function seedCompose(input: {
  mode: Exclude<ComposeMode, "new">;
  threadGmailId: string;
  baseSubject: string;
  messages: readonly Message[];
  /** The sending account: its addresses are dropped from reply-all
   *  recipients and pick the From. */
  me?: Sender;
}): ComposeSeed {
  const { mode, threadGmailId, baseSubject, messages, me } = input;
  const last = replyTarget(messages, me);
  const subjPrefix = mode === "forward" ? "Fwd: " : "Re: ";
  const subject = baseSubject.startsWith(subjPrefix.trim())
    ? baseSubject
    : subjPrefix + baseSubject.replace(/^(Re|Fwd):\s*/i, "");
  const seed: ComposeSeed = { to: [], subject, body_text: "" };
  if (!last) return seed;
  const from = me && answeredAs(me, last);
  if (from) seed.from = from;
  if (mode === "reply") {
    seed.to = [last.reply_to ?? last.from];
  } else if (mode === "replyAll") {
    const everyone = [last.from, ...last.to, ...(last.cc ?? [])];
    const seen = new Set<string>();
    seed.to = everyone.filter((a) => {
      if ((me && isOwnAddress(me, a.email)) || seen.has(a.email)) return false;
      seen.add(a.email);
      return true;
    });
  } else if (mode === "forward") {
    if (last.body_text || last.snippet) {
      seed.body_text = `\n\n———— Forwarded message ————\nFrom: ${last.from.name ?? last.from.email}\nDate: ${new Date(last.date).toLocaleString()}\n\n${last.body_text ?? last.snippet}`;
    }
    const files = forwardedAttachments(last);
    if (files.length) seed.attachments = files;
  }
  // A forward stays in its conversation, as Gmail files it: same thread,
  // with the forwarded message's headers in its reference chain.
  seed.thread_gmail_id = threadGmailId;
  seed.reply_to_gmail_id = last.gmail_id;
  return seed;
}

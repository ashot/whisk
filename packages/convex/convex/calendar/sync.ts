import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, ActionCtx, MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { GmailApiError, getAccessToken } from "../gmail/api";
import { hasCalendarScope } from "../gmail/oauth";
import { ParsedCalendar, ParsedEvent, getEvent, listCalendars, listEvents, parseCalendarListEntry, parseGoogleEvent, providerEventPatch } from "./api";

export const WINDOW_PAST_MS = 14 * 86400000;
export const WINDOW_FUTURE_MS = 62 * 86400000;
const FULL_INTERVAL_MS = 86400000;
const SYNC_LEASE_MS = 10 * 60000;

async function active(ctx: Pick<MutationCtx, "db">, accountId: Id<"accounts">, run: string) {
  const account = await ctx.db.get(accountId);
  return !!account && account.calendar_sync_run === run && hasCalendarScope(account.scopes);
}

function protectedEvent(row: Doc<"events">, started: number) {
  return !!row.pending_outbound || !!row.write_error || (row.local_written_at ?? 0) >= started;
}

export const claimSync = internalMutation({
  args: { accountId: v.id("accounts"), run: v.string() },
  handler: async (ctx, { accountId, run }) => {
    const account = await ctx.db.get(accountId);
    if (!account || account.provider !== "gmail" || !hasCalendarScope(account.scopes)) return null;
    const now = Date.now();
    if (account.calendar_sync_run && now - (account.calendar_sync_started_at ?? 0) < SYNC_LEASE_MS) return null;
    await ctx.db.patch(accountId, { calendar_sync_run: run, calendar_sync_started_at: now });
    return now;
  },
});

export const syncAccount = internalAction({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }): Promise<{ skipped: boolean; applied?: number; error?: string }> => {
    const run = crypto.randomUUID();
    const started: number | null = await ctx.runMutation(internal.calendar.sync.claimSync, { accountId, run });
    if (started === null) return { skipped: true };
    let applied = 0;
    let error: string | undefined;
    try {
      const accessToken = await getAccessToken(ctx, accountId);
      const listed = (await listCalendars(accessToken)).filter(c => !c.deleted && ["reader", "writerWithoutPrivateAccess", "writer", "owner"].includes(c.accessRole ?? "reader"));
      const calendars: Doc<"calendars">[] = await ctx.runMutation(internal.calendar.sync.upsertCalendars, {
        accountId, run, calendars: listed.map(parseCalendarListEntry),
      });
      const errors: string[] = [];
      for (const calendar of calendars) {
        try {
          applied += await syncCalendar(ctx, accountId, accessToken, calendar, run, started);
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          errors.push(`${calendar.summary}: ${message}`);
        }
      }
      error = errors.length ? errors.join("; ").slice(0, 1000) : undefined;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    await ctx.runMutation(internal.calendar.sync.markSynced, { accountId, run, error });
    return { skipped: false, applied, error };
  },
});

async function syncCalendar(ctx: ActionCtx, accountId: Id<"accounts">, accessToken: string, calendar: Doc<"calendars">, run: string, started: number) {
  let full = !calendar.sync_token || !calendar.full_synced_at || started - calendar.full_synced_at >= FULL_INTERVAL_MS;
  const from = full ? started - WINDOW_PAST_MS : calendar.window_start ?? started - WINDOW_PAST_MS;
  const to = full ? started + WINDOW_FUTURE_MS : calendar.window_end ?? started + WINDOW_FUTURE_MS;
  const disabled = calendar.deleted;
  let applied = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const windowStart = full ? started - WINDOW_PAST_MS : from;
    const windowEnd = full ? started + WINDOW_FUTURE_MS : to;
    try {
      let pageToken: string | undefined;
      let syncToken: string | undefined;
      let pages = 0;
      if (!disabled) {
        do {
          if (++pages > 200) throw new Error("Calendar sync exceeded 200 pages; cursor retained for retry");
          const page = await listEvents(accessToken, calendar.google_id, {
            syncToken: full ? undefined : calendar.sync_token, pageToken,
            timeMin: full ? new Date(windowStart).toISOString() : undefined,
            timeMax: full ? new Date(windowEnd).toISOString() : undefined,
          });
          const events = (page.items ?? []).map(raw => {
            const event = parseGoogleEvent(raw, calendar.google_id);
            if (!event) throw new Error(`Invalid event ${raw.id}; cursor retained for retry`);
            return event;
          });
          for (let i = 0; i < events.length; i += 50) {
            const accepted: boolean = await ctx.runMutation(internal.calendar.sync.applyEvents, {
              accountId, run, started, full, windowStart, windowEnd, events: events.slice(i, i + 50),
            });
            if (!accepted) return applied;
          }
          applied += events.length;
          pageToken = page.nextPageToken;
          syncToken = page.nextSyncToken;
        } while (pageToken);
        if (!syncToken) throw new Error("Calendar response omitted sync token; cursor retained for retry");
      }
      if (full || disabled) {
        let cursor: string | null = null;
        do {
          const result: { cursor: string | null } = await ctx.runMutation(internal.calendar.sync.reconcilePage, {
            accountId, calendarId: calendar._id, run, started, cursor, disabled: !!disabled,
          });
          cursor = result.cursor;
        } while (cursor);
      }
      await ctx.runMutation(internal.calendar.sync.setSyncToken, {
        calendarId: calendar._id, run, sync_token: disabled ? undefined : syncToken,
        full, windowStart, windowEnd, started,
      });
      return applied;
    } catch (caught) {
      if (caught instanceof GmailApiError && caught.status === 410 && !full) {
        full = true;
        continue;
      }
      throw caught;
    }
  }
  return applied;
}

export const syncAllAccounts = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const accountIds: Id<"accounts">[] = await ctx.runQuery(internal.calendar.sync.accountsWithCalendar, {});
    for (const accountId of accountIds) await ctx.scheduler.runAfter(0, internal.calendar.sync.syncAccount, { accountId });
    return { scheduled: accountIds.length };
  },
});

export const accountsWithCalendar = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("accounts").collect())
    .filter(a => a.provider === "gmail" && hasCalendarScope(a.scopes)).map(a => a._id),
});

export const markSynced = internalMutation({
  args: { accountId: v.id("accounts"), run: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, { accountId, run, error }) => {
    if (!await active(ctx, accountId, run)) return;
    const account = (await ctx.db.get(accountId))!;
    await ctx.db.patch(accountId, {
      calendar_synced_at: error ? account.calendar_synced_at : Date.now(), calendar_error: error,
      calendar_sync_run: undefined, calendar_sync_started_at: undefined, updated_at: Date.now(),
    });
  },
});

export const setSyncToken = internalMutation({
  args: { calendarId: v.id("calendars"), run: v.string(), sync_token: v.optional(v.string()), full: v.boolean(), windowStart: v.number(), windowEnd: v.number(), started: v.number() },
  handler: async (ctx, args) => {
    const calendar = await ctx.db.get(args.calendarId);
    if (!calendar || !await active(ctx, calendar.account_id, args.run)) return;
    await ctx.db.patch(calendar._id, {
      sync_token: args.sync_token,
      full_synced_at: args.full ? args.started : calendar.full_synced_at,
      window_start: args.windowStart, window_end: args.windowEnd,
    });
  },
});

export const upsertCalendars = internalMutation({
  args: { accountId: v.id("accounts"), run: v.string(), calendars: v.array(v.any()) },
  handler: async (ctx, { accountId, run, calendars }): Promise<Doc<"calendars">[]> => {
    if (!await active(ctx, accountId, run)) return [];
    const now = Date.now();
    const seen = new Set<string>();
    const out: Doc<"calendars">[] = [];
    for (const parsed of calendars as ParsedCalendar[]) {
      seen.add(parsed.google_id);
      const existing = await ctx.db.query("calendars").withIndex("by_account_google", q =>
        q.eq("account_id", accountId).eq("google_id", parsed.google_id)).unique();
      if (existing) {
        const reset = existing.deleted || existing.access_role !== parsed.access_role;
        const changed = Object.entries(parsed).some(([key, value]) => existing[key as keyof typeof existing] !== value);
        if (changed || existing.deleted) await ctx.db.patch(existing._id, {
          ...parsed, deleted: undefined, sync_token: reset ? undefined : existing.sync_token, updated_at: now,
        });
        out.push((await ctx.db.get(existing._id))!);
      } else {
        const id = await ctx.db.insert("calendars", { account_id: accountId, ...parsed, updated_at: now });
        out.push((await ctx.db.get(id))!);
      }
    }
    const existing = await ctx.db.query("calendars").withIndex("by_account", q => q.eq("account_id", accountId)).collect();
    for (const calendar of existing) {
      if (seen.has(calendar.google_id)) continue;
      if (!calendar.deleted) await ctx.db.patch(calendar._id, { deleted: true, sync_token: undefined, updated_at: now });
      out.push({ ...calendar, deleted: true });
    }
    return out;
  },
});

export const reconcilePage = internalMutation({
  args: { accountId: v.id("accounts"), calendarId: v.id("calendars"), run: v.string(), started: v.number(), cursor: v.union(v.string(), v.null()), disabled: v.boolean() },
  handler: async (ctx, args): Promise<{ cursor: string | null }> => {
    const calendar = await ctx.db.get(args.calendarId);
    if (!calendar || calendar.account_id !== args.accountId || !await active(ctx, args.accountId, args.run)) return { cursor: null };
    const page = await ctx.db.query("events").withIndex("by_account_google", q =>
      q.eq("account_id", args.accountId).eq("calendar_google_id", calendar.google_id)).paginate({ cursor: args.cursor, numItems: 100 });
    for (const row of page.page) {
      if (protectedEvent(row, args.started)) {
        await scheduleReconcile(ctx, row);
        continue;
      }
      if (row.deleted) continue;
      if (args.disabled || row.sync_generation !== args.run) await ctx.db.patch(row._id, { deleted: true, updated_at: Date.now() });
    }
    return { cursor: page.isDone ? null : page.continueCursor };
  },
});

export const applyEvents = internalMutation({
  args: { accountId: v.id("accounts"), run: v.string(), started: v.number(), full: v.boolean(), windowStart: v.number(), windowEnd: v.number(), events: v.array(v.any()) },
  handler: async (ctx, { accountId, run, started, full, windowStart, windowEnd, events }) => {
    if (!await active(ctx, accountId, run)) return false;
    const now = Date.now();
    for (const parsed of events as ParsedEvent[]) {
      const calendar = await ctx.db.query("calendars").withIndex("by_account_google", q =>
        q.eq("account_id", accountId).eq("google_id", parsed.calendar_google_id)).unique();
      if (!calendar || calendar.deleted) continue;
      const existing = await ctx.db.query("events").withIndex("by_account_google", q =>
        q.eq("account_id", accountId).eq("calendar_google_id", parsed.calendar_google_id).eq("google_id", parsed.google_id)).unique();
      if (existing && full) await ctx.db.patch(existing._id, { sync_generation: run });
      if (existing && protectedEvent(existing, started)) {
        await scheduleReconcile(ctx, existing);
        continue;
      }
      const deleted = parsed.status === "cancelled" || parsed.end <= windowStart || parsed.start >= windowEnd;
      if (deleted) {
        if (existing && !existing.deleted) await ctx.db.patch(existing._id, { deleted: true, updated_at: now });
        continue;
      }
      if (existing) {
        const changed = existing.deleted || Object.entries(providerEventPatch(parsed)).some(([key, value]) =>
          JSON.stringify(existing[key as keyof typeof existing]) !== JSON.stringify(value));
        if (changed) await ctx.db.patch(existing._id, { ...providerEventPatch(parsed), deleted: undefined, updated_at: now });
      } else {
        await ctx.db.insert("events", { account_id: accountId, ...parsed, sync_generation: full ? run : undefined, updated_at: now });
      }
    }
    return true;
  },
});

const DELAY_MS = 30000;
const STALE_JOB_MS = 10 * 60000;

export async function scheduleReconcile(ctx: Pick<MutationCtx, "db" | "scheduler">, event: Doc<"events">, retry = false, failures = 0): Promise<void> {
  if (!retry && event.reconcile_after !== undefined && event.reconcile_after > Date.now() - STALE_JOB_MS) return;
  const after = Math.max(Date.now() + Math.min(DELAY_MS * 2 ** failures, 5 * 60000), (event.reconcile_after ?? 0) + 1);
  await ctx.db.patch(event._id, { reconcile_after: after });
  await ctx.scheduler.runAt(after, internal.calendar.sync.reconcileEvent, { eventId: event._id, after, failures });
}

const jobArgs = { eventId: v.id("events"), after: v.number() };

function progressingWrite(event: Doc<"events">, pending: Doc<"outbound"> | null) {
  return pending?.status === "inflight" || (pending?.status === "queued" && !event.write_error);
}

export const prepareReconcile = internalMutation({
  args: jobArgs,
  handler: async (ctx, { eventId, after }): Promise<Doc<"events"> | null> => {
    const event = await ctx.db.get(eventId);
    if (!event || event.reconcile_after !== after) return null;
    const account = await ctx.db.get(event.account_id);
    if (!account || account.provider !== "gmail" || !hasCalendarScope(account.scopes)) {
      await ctx.db.patch(eventId, { reconcile_after: undefined });
      return null;
    }
    if (event.pending_outbound) {
      const pending = await ctx.db.get(event.pending_outbound);
      if (progressingWrite(event, pending)) {
        await scheduleReconcile(ctx, event, true);
        return null;
      }
    }
    await ctx.scheduler.runAfter(STALE_JOB_MS, internal.calendar.sync.reconcileEvent, { eventId, after });
    return event;
  },
});

export const reconcileEvent = internalAction({
  args: { ...jobArgs, failures: v.optional(v.number()) },
  handler: async (ctx, { eventId, after, failures = 0 }): Promise<void> => {
    const event: Doc<"events"> | null = await ctx.runMutation(internal.calendar.sync.prepareReconcile, { eventId, after });
    if (!event) return;
    let parsed: ParsedEvent | undefined;
    let missing = false;
    let error: string | undefined;
    try {
      const token = await getAccessToken(ctx, event.account_id);
      const raw = await getEvent(token, event.calendar_google_id, event.google_id);
      parsed = parseGoogleEvent(raw, event.calendar_google_id) ?? undefined;
      if (!parsed) throw new Error("Google returned an invalid event during calendar catch-up");
    } catch (caught) {
      if (caught instanceof GmailApiError && [404, 410].includes(caught.status)) missing = true;
      else error = caught instanceof Error ? caught.message : String(caught);
    }
    await ctx.runMutation(internal.calendar.sync.finishReconcile, {
      eventId, after, failures, event: parsed, missing, error,
      writtenAt: event.local_written_at, updatedAt: event.updated_at,
    });
  },
});

export const finishReconcile = internalMutation({
  args: { ...jobArgs, failures: v.number(), event: v.optional(v.any()), missing: v.boolean(), error: v.optional(v.string()), writtenAt: v.optional(v.number()), updatedAt: v.number() },
  handler: async (ctx, args) => {
    const local = await ctx.db.get(args.eventId);
    if (!local || local.reconcile_after !== args.after) return;
    const account = await ctx.db.get(local.account_id);
    if (!account || account.provider !== "gmail" || !hasCalendarScope(account.scopes)) {
      await ctx.db.patch(local._id, { reconcile_after: undefined });
      return;
    }
    const pending = local.pending_outbound ? await ctx.db.get(local.pending_outbound) : null;
    if (progressingWrite(local, pending) || local.local_written_at !== args.writtenAt || local.updated_at !== args.updatedAt) {
      await scheduleReconcile(ctx, local, true);
      return;
    }
    if (args.error) {
      await ctx.db.patch(account._id, { calendar_error: `Calendar catch-up: ${args.error}`.slice(0, 1000), updated_at: Date.now() });
      await scheduleReconcile(ctx, local, true, Math.min(args.failures + 1, 4));
      return;
    }
    if (account.calendar_error?.startsWith("Calendar catch-up:")) await ctx.db.patch(account._id, { calendar_error: undefined, updated_at: Date.now() });
    const calendar = await ctx.db.query("calendars").withIndex("by_account_google", q =>
      q.eq("account_id", local.account_id).eq("google_id", local.calendar_google_id)).unique();
    const parsed = args.event as ParsedEvent | undefined;
    const deleted = !calendar || calendar.deleted || args.missing || parsed?.status === "cancelled" ||
      (parsed && (parsed.end <= (calendar.window_start ?? 0) || parsed.start >= (calendar.window_end ?? Infinity)));
    if (deleted) {
      await ctx.db.patch(local._id, {
        deleted: args.missing && local.client_id && local.write_error ? local.deleted : true,
        reconcile_after: undefined, updated_at: Date.now(),
      });
    } else if (parsed) {
      await ctx.db.patch(local._id, { ...providerEventPatch(parsed), deleted: undefined, reconcile_after: undefined, local_written_at: Math.max(Date.now(), (local.local_written_at ?? 0) + 1), updated_at: Date.now() });
    }
  },
});

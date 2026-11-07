import { v } from "convex/values";
import { FRESH_MS } from "../lib/pushPlan";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import {
  GmailApiError,
  ParsedMessage,
  collapseHistory,
  getAccessToken,
  getMessage,
  getProfile,
  getThread,
  listHistory,
  listLabels,
  listSendAs,
  listThreads,
  parseGmailMessage,
} from "./api";
import {
  applyLabelDelta,
  recomputeThread,
  sameLabels,
  settleThread,
  threadByGmailId,
} from "../lib/threads";
import { adoptGmailDraft, dropGmailDraft, isGmailDraft } from "../lib/drafts";
import { clusteringSettings, scheduleClustering } from "../clusters";
import { hasEnabledFilters } from "../filters";
import { schedulePrivacyCheck } from "../privacy";
import { heuristicCategory } from "../lib/categorize";
import { isOwnAddress } from "@mail/shared/src/lib/sendAs";

// Gmail is the system of record. Backfill establishes a projection and a
// history cursor; incremental replays history onto it. Both run as actions and
// write through internal mutations, so a page of work is one transaction.

const BACKFILL_PAGE = 100;
// How many threads.get calls run at once. Enough to keep a backfill brisk,
// small enough to stay well inside Gmail's per-user rate limit.
const FETCH_CONCURRENCY = 10;
const MAX_BACKFILL_THREADS = 500;
const BACKFILL_WINDOW = "newer_than:90d";
// Applying a message rereads its whole thread (bodies included) through
// recomputeThread, so a mutation's bytes-read scales with batch size times
// thread weight. Convex caps a mutation at 16MB read; these batch sizes keep
// a page of history far under it — a backlog that once arrived as one giant
// apply is the documented way a mailbox wedged (every retry failed the same).
const APPLY_MESSAGE_BATCH = 10;
const APPLY_LABEL_BATCH = 50;
const APPLY_DELETE_BATCH = 200;
// Send-as addresses change rarely (a new alias, a new default), so an hourly
// reread on the incremental path is fresh enough and costs one call.
const SEND_AS_REFRESH_MS = 60 * 60 * 1000;

/** Reread the addresses the mailbox may send as. A failure keeps the last
 *  list: this must never wedge mail sync. */
async function refreshSendAs(ctx: any, accountId: Id<"accounts">, accessToken: string): Promise<void> {
  try {
    const send_as = await listSendAs(accessToken);
    await ctx.runMutation(internal.gmail.sync.setSendAs, { accountId, send_as });
  } catch (caught) {
    console.warn("send-as read failed", accountId, syncErrorText(caught));
  }
}

/** A sync_error a human can act on: keep the API body for 4xx, not just the
 *  status line. */
function syncErrorText(caught: unknown): string {
  if (caught instanceof GmailApiError && caught.body) {
    return `${caught.message} — ${caught.body.slice(0, 300)}`;
  }
  return caught instanceof Error ? caught.message : String(caught);
}

export const backfill = internalAction({
  args: {
    accountId: v.id("accounts"),
    pageToken: v.optional(v.string()),
    fetched: v.optional(v.number()),
  },
  handler: async (ctx, { accountId, pageToken, fetched }) => {
    const already = fetched ?? 0;
    try {
      const accessToken = await getAccessToken(ctx, accountId);

      if (already === 0) {
        await ctx.runMutation(internal.gmail.sync.setSyncStatus, {
          accountId,
          sync_status: "backfilling",
          clear_error: true,
        });
        await refreshSendAs(ctx, accountId, accessToken);
        const labels = await listLabels(accessToken);
        await ctx.runMutation(internal.gmail.sync.upsertLabels, {
          accountId,
          labels: (labels.labels ?? []).map((label) => ({
            gmail_id: label.id,
            name: label.name,
            kind: label.type === "user" ? ("user" as const) : ("system" as const),
            color: label.color?.backgroundColor,
          })),
        });
      }

      const page = await listThreads(accessToken, {
        maxResults: BACKFILL_PAGE,
        pageToken,
        q: BACKFILL_WINDOW,
      });
      const ids = (page.threads ?? []).map((t) => t.id);
      const budget = Math.max(0, MAX_BACKFILL_THREADS - already);
      const take = ids.slice(0, budget);

      for (let i = 0; i < take.length; i += FETCH_CONCURRENCY) {
        const chunk = take.slice(i, i + FETCH_CONCURRENCY);
        const threads = await Promise.all(
          chunk.map((id) => getThread(accessToken, id)),
        );
        const messages: ParsedMessage[] = [];
        for (const thread of threads) {
          for (const message of thread.messages ?? []) {
            messages.push(parseGmailMessage(message));
          }
        }
        if (messages.length > 0) {
          await ctx.runMutation(internal.gmail.sync.applySyncedMessages, {
            accountId,
            messages,
          });
        }
      }

      const total = already + take.length;
      if (page.nextPageToken && total < MAX_BACKFILL_THREADS) {
        await ctx.scheduler.runAfter(0, internal.gmail.sync.backfill, {
          accountId,
          pageToken: page.nextPageToken,
          fetched: total,
        });
        return { done: false, fetched: total };
      }

      // The cursor is taken AFTER the projection is in place, so nothing that
      // happened during the backfill can be missed by the first incremental.
      const profile = await getProfile(accessToken);
      await ctx.runMutation(internal.gmail.sync.setSyncStatus, {
        accountId,
        sync_status: "idle",
        history_id: profile.historyId,
        last_synced_at: Date.now(),
        clear_error: true,
      });
      // The mailbox now holds the owner's sent mail — distill their voice.
      // Guarded on configuration: an unconfigured deployment schedules nothing.
      if (process.env.ANTHROPIC_API_KEY) {
        await ctx.scheduler.runAfter(0, internal.ai.actions.buildStyleProfile, {
          accountId,
        });
      }
      return { done: true, fetched: total };
    } catch (caught) {
      await ctx.runMutation(internal.gmail.sync.setSyncStatus, {
        accountId,
        sync_status: "error",
        sync_error: syncErrorText(caught),
      });
      throw caught;
    }
  },
});

export const incremental = internalAction({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const account = await ctx.runQuery(internal.gmail.sync.accountFor, {
      accountId,
    });
    if (!account || account.provider !== "gmail") return { skipped: true };
    if (!account.history_id) {
      await ctx.scheduler.runAfter(0, internal.gmail.sync.backfill, { accountId });
      return { skipped: false, restarted: true };
    }

    try {
      const accessToken = await getAccessToken(ctx, accountId);
      await ctx.runMutation(internal.gmail.sync.setSyncStatus, {
        accountId,
        sync_status: "syncing",
        clear_error: true,
      });
      if (Date.now() - (account.send_as_at ?? 0) > SEND_AS_REFRESH_MS) {
        await refreshSendAs(ctx, accountId, accessToken);
      }

      let pageToken: string | undefined;
      let latestHistoryId = account.history_id;
      let applied = 0;

      do {
        const page = await listHistory(accessToken, {
          startHistoryId: account.history_id,
          pageToken,
        });
        if (page.historyId) latestHistoryId = page.historyId;
        const effect = collapseHistory(page);

        if (effect.added.length > 0) {
          const messages: ParsedMessage[] = [];
          for (let i = 0; i < effect.added.length; i += FETCH_CONCURRENCY) {
            const chunk = effect.added.slice(i, i + FETCH_CONCURRENCY);
            const fetched = await Promise.all(
              chunk.map((m) =>
                getMessage(accessToken, m.messageId).catch(() => null),
              ),
            );
            for (const message of fetched) {
              if (message) messages.push(parseGmailMessage(message));
            }
          }
          for (let i = 0; i < messages.length; i += APPLY_MESSAGE_BATCH) {
            await ctx.runMutation(internal.gmail.sync.applySyncedMessages, {
              accountId,
              messages: messages.slice(i, i + APPLY_MESSAGE_BATCH),
            });
          }
          applied += messages.length;
        }

        if (effect.labelChanges.size > 0) {
          const changes = [...effect.labelChanges.entries()].map(
            ([id, change]) => ({
              gmail_id: id,
              thread_gmail_id: change.threadId,
              add: [...change.add],
              remove: [...change.remove],
            }),
          );
          for (let i = 0; i < changes.length; i += APPLY_LABEL_BATCH) {
            await ctx.runMutation(internal.gmail.sync.applyLabelChanges, {
              accountId,
              changes: changes.slice(i, i + APPLY_LABEL_BATCH),
            });
          }
          applied += changes.length;
        }

        if (effect.deleted.length > 0) {
          for (let i = 0; i < effect.deleted.length; i += APPLY_DELETE_BATCH) {
            await ctx.runMutation(internal.gmail.sync.markMessagesDeleted, {
              accountId,
              messages: effect.deleted
                .slice(i, i + APPLY_DELETE_BATCH)
                .map((m) => ({
                  gmail_id: m.messageId,
                  thread_gmail_id: m.threadId,
                })),
            });
          }
          applied += effect.deleted.length;
        }

        // Checkpoint the cursor to the last history record this page fully
        // applied. If the action dies mid-backlog (crash, runtime limit), the
        // next run resumes here instead of replaying — and refetching — the
        // whole backlog from the original cursor. That replay is what turned
        // one oversized page into a permanent wedge.
        const records = page.history ?? [];
        const pageWatermark = records[records.length - 1]?.id;
        if (pageWatermark) {
          await ctx.runMutation(internal.gmail.sync.setSyncStatus, {
            accountId,
            sync_status: "syncing",
            history_id: pageWatermark,
          });
        }

        pageToken = page.nextPageToken;
      } while (pageToken);

      await ctx.runMutation(internal.gmail.sync.setSyncStatus, {
        accountId,
        sync_status: "idle",
        history_id: latestHistoryId,
        last_synced_at: Date.now(),
        clear_error: true,
      });
      return { skipped: false, applied };
    } catch (caught) {
      // A 404 means the history cursor aged out of Gmail's window. The only
      // honest recovery is a fresh projection.
      if (caught instanceof GmailApiError && caught.status === 404) {
        await ctx.runMutation(internal.gmail.sync.setSyncStatus, {
          accountId,
          sync_status: "backfilling",
          clear_history_id: true,
          clear_error: true,
        });
        await ctx.scheduler.runAfter(0, internal.gmail.sync.backfill, {
          accountId,
        });
        return { skipped: false, restarted: true };
      }
      await ctx.runMutation(internal.gmail.sync.setSyncStatus, {
        accountId,
        sync_status: "error",
        sync_error: syncErrorText(caught),
      });
      throw caught;
    }
  },
});

/** Cron entry point: wake every connected Gmail account. */
export const syncAllAccounts = internalAction({
  args: {},
  handler: async (ctx) => {
    const accountIds: Id<"accounts">[] = await ctx.runQuery(
      internal.gmail.oauth.accountsToSync,
      {},
    );
    for (const accountId of accountIds) {
      await ctx.scheduler.runAfter(0, internal.gmail.sync.incremental, {
        accountId,
      });
    }
    return { scheduled: accountIds.length };
  },
});

// ---------------------------------------------------------------------------
// Write side
// ---------------------------------------------------------------------------

export const accountFor = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => await ctx.db.get(accountId),
});

export const setSyncStatus = internalMutation({
  args: {
    accountId: v.id("accounts"),
    sync_status: v.union(
      v.literal("idle"),
      v.literal("backfilling"),
      v.literal("syncing"),
      v.literal("error"),
    ),
    sync_error: v.optional(v.string()),
    history_id: v.optional(v.string()),
    last_synced_at: v.optional(v.number()),
    clear_error: v.optional(v.boolean()),
    clear_history_id: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {
      sync_status: args.sync_status,
      updated_at: Date.now(),
    };
    if (args.sync_error !== undefined) patch.sync_error = args.sync_error;
    if (args.clear_error) patch.sync_error = undefined;
    if (args.history_id !== undefined) patch.history_id = args.history_id;
    if (args.clear_history_id) patch.history_id = undefined;
    if (args.last_synced_at !== undefined) {
      patch.last_synced_at = args.last_synced_at;
    }
    await ctx.db.patch(args.accountId, patch);
  },
});

export const setSendAs = internalMutation({
  args: {
    accountId: v.id("accounts"),
    send_as: v.array(v.object({ email: v.string(), name: v.optional(v.string()), is_default: v.optional(v.boolean()) })),
  },
  handler: async (ctx, { accountId, send_as }) => {
    const row = await ctx.db.get(accountId);
    if (!row) return;
    const now = Date.now();
    // updated_at moves only on a real change, so the hourly reread does not
    // push an unchanged account row to every device.
    const changed = JSON.stringify(row.send_as ?? []) !== JSON.stringify(send_as);
    await ctx.db.patch(accountId, { send_as, send_as_at: now, ...(changed ? { updated_at: now } : {}) });
  },
});

export const upsertLabels = internalMutation({
  args: {
    accountId: v.id("accounts"),
    labels: v.array(
      v.object({
        gmail_id: v.string(),
        name: v.string(),
        kind: v.union(v.literal("system"), v.literal("user")),
        color: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { accountId, labels }) => {
    const now = Date.now();
    for (const label of labels) {
      const existing = await ctx.db
        .query("labels")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", accountId).eq("gmail_id", label.gmail_id),
        )
        .unique();
      if (existing) {
        // Skip a no-op write so the client's delta watermark stays quiet.
        if (
          existing.name === label.name &&
          existing.kind === label.kind &&
          existing.color === label.color &&
          !existing.deleted
        ) {
          continue;
        }
        await ctx.db.patch(existing._id, {
          ...label,
          deleted: undefined,
          updated_at: now,
        });
      } else {
        await ctx.db.insert("labels", {
          account_id: accountId,
          ...label,
          updated_at: now,
        });
      }
    }
  },
});

/**
 * Upsert parsed messages and rewrite every thread they touched. The thread
 * subject comes from the earliest message, matching what Gmail shows.
 */
export const applySyncedMessages = internalMutation({
  args: { accountId: v.id("accounts"), messages: v.array(v.any()) },
  handler: async (ctx, { accountId, messages }) => {
    const now = Date.now();
    const threadSubjects = new Map<string, { date: number; subject: string }>();
    const newInbound = new Set<string>();
    const owner = await ctx.db.get(accountId);

    for (const parsed of messages as ParsedMessage[]) {
      if (isGmailDraft(parsed)) {
        await adoptGmailDraft(ctx, accountId, parsed);
        continue;
      }
      const { subject, ...fields } = parsed;
      const earliest = threadSubjects.get(parsed.thread_gmail_id);
      if (!earliest || parsed.date < earliest.date) {
        threadSubjects.set(parsed.thread_gmail_id, {
          date: parsed.date,
          subject,
        });
      }

      const existing = await ctx.db
        .query("messages")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", accountId).eq("gmail_id", parsed.gmail_id),
        )
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, {
          ...fields,
          deleted: undefined,
          updated_at: now,
        });
        continue;
      }

      // A send that just landed already has a local row keyed by client_id;
      // the pump rekeys it, but a history race can deliver the real message
      // first. Adopting the local row keeps the client's stub from doubling.
      // Looked up by Message-ID through its own index: at most a row or two
      // read, where scanning the thread pulled every body in it.
      const local = parsed.header_message_id
        ? await ctx.db
            .query("messages")
            .withIndex("by_account_header", (q) =>
              q
                .eq("account_id", accountId)
                .eq("header_message_id", parsed.header_message_id),
            )
            .collect()
            .then((rows) => rows.find((row) => !!row.client_id))
        : undefined;

      if (local) {
        await ctx.db.patch(local._id, {
          ...fields,
          deleted: undefined,
          updated_at: now,
        });
        continue;
      }

      if (!(owner && isOwnAddress(owner, parsed.from.email)) && parsed.label_ids.includes("INBOX") && !parsed.label_ids.includes("SPAM") && !parsed.label_ids.includes("TRASH")) newInbound.add(parsed.thread_gmail_id);
      await ctx.db.insert("messages", {
        account_id: accountId,
        ...fields,
        updated_at: now,
      });
    }

    for (const [threadGmailId, { subject }] of threadSubjects) {
      const thread = await threadByGmailId(ctx, accountId, threadGmailId);
      if (!thread) {
        await ctx.db.insert("threads", {
          account_id: accountId,
          gmail_id: threadGmailId,
          subject,
          snippet: "",
          participants: [],
          message_count: 0,
          last_at: now,
          label_ids: [],
          is_unread: false,
          is_starred: false,
          has_attachments: false,
          updated_at: now,
        });
      }
      // A thread we had tombstoned is alive again if Gmail hands us a message
      // in it, so the recompute clears the marker in the same patch.
      await recomputeThread(ctx, accountId, threadGmailId, {
        subject,
        deleted: undefined,
      });
    }

    // Every thread this apply changed is read against the person's privacy
    // rules again (agents cannot see it until it has been), whoever wrote
    // the new message.
    await schedulePrivacyCheck(ctx, accountId, [...threadSubjects.keys()]);

    // Classification, cheapest layer first: learned sender rules, then the
    // structural heuristics — both free, applied right here — and only what
    // neither can place goes to the model in one scheduled batch.
    const account = await ctx.db.get(accountId);
    // Newest inbound message per touched thread names the sender to judge by.
    const inboundBy = new Map<string, ParsedMessage>();
    for (const parsed of messages as ParsedMessage[]) {
      if (account && isOwnAddress(account, parsed.from.email)) continue;
      const prev = inboundBy.get(parsed.thread_gmail_id);
      if (!prev || parsed.date > prev.date) {
        inboundBy.set(parsed.thread_gmail_id, parsed);
      }
    }
    let rules: Array<{ contact_email?: string; category?: string }> | null = null;
    const toClassify: string[] = [];
    const firstSeen = [...newInbound];
    for (const [threadGmailId, inbound] of inboundBy) {
      const thread = await threadByGmailId(ctx, accountId, threadGmailId);
      if (!thread || thread.deleted || thread.category_source) continue;

      if (rules === null) {
        const memoryRows = await ctx.db
          .query("memories")
          .withIndex("by_account", (q) => q.eq("account_id", accountId))
          .collect();
        rules = memoryRows.filter((m) => m.kind === "rule" && !m.deleted);
      }
      // Rules key on the thread's starter, matching the correction sweep — a
      // rule about a sender applies to threads they open, not ones they join.
      const sender = (thread.participants[0]?.email ?? inbound.from.email).toLowerCase();
      const rule = rules.find((r) => r.contact_email === sender);
      if (rule) {
        await ctx.db.patch(thread._id, {
          category: rule.category ?? undefined,
          category_source: "rule",
          updated_at: now,
        });
        continue;
      }
      const guess = heuristicCategory({
        fromEmail: inbound.from.email,
        fromName: inbound.from.name,
        subject: threadSubjects.get(threadGmailId)?.subject ?? thread.subject,
        labelIds: inbound.label_ids,
      });
      if (guess) {
        await ctx.db.patch(thread._id, {
          category: guess,
          category_source: "heuristic",
          updated_at: now,
        });
        continue;
      }
      toClassify.push(threadGmailId);
    }
    // Guarded on configuration so an unconfigured deployment (and every unit
    // test) schedules no model work.
    if (toClassify.length > 0 && process.env.ANTHROPIC_API_KEY) {
      await ctx.scheduler.runAfter(0, internal.ai.actions.classifyThreads, {
        accountId,
        threadGmailIds: toClassify,
      });
    }
    // Fresh inbound mail on a mailbox past its backfill is news for the
    // phone. The push starts now and sends as soon as the model work started
    // below (lane, filters) has said its piece about these threads; mail this
    // sync placed by itself does not wait at all.
    if (firstSeen.length > 0 && account?.history_id && account.sync_status !== "backfilling") {
      const fresh = firstSeen.filter((id) => (inboundBy.get(id)?.date ?? 0) > now - FRESH_MS);
      if (fresh.length > 0) {
        await ctx.scheduler.runAfter(0, internal.push.notifyNewMail, { accountId, threadGmailIds: fresh, since: now });
      }
    }
    // The same first sight of a thread feeds the person's filters (judged
    // now, in one batch) and the topic clusters (debounced, so a backfill
    // costs one pass).
    if (firstSeen.length > 0 && process.env.ANTHROPIC_API_KEY && account) {
      // New mail from someone else can change where a thread belongs, so
      // every such thread is scored again on every lens.
      await ctx.scheduler.runAfter(0, internal.ai.actions.judgeLenses, {
        accountId,
        threadGmailIds: firstSeen,
      });
      if (await hasEnabledFilters(ctx, accountId)) {
        await ctx.scheduler.runAfter(0, internal.ai.actions.judgeFilters, {
          accountId,
          threadGmailIds: firstSeen,
        });
      }
      if ((await clusteringSettings(ctx, account)).enabled) {
        await scheduleClustering(ctx, account);
      }
    }
  },
});

export const applyLabelChanges = internalMutation({
  args: {
    accountId: v.id("accounts"),
    changes: v.array(
      v.object({
        gmail_id: v.string(),
        thread_gmail_id: v.string(),
        add: v.array(v.string()),
        remove: v.array(v.string()),
      }),
    ),
  },
  handler: async (ctx, { accountId, changes }) => {
    const now = Date.now();
    const touchedThreads = new Set<string>();

    for (const change of changes) {
      const message = await ctx.db
        .query("messages")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", accountId).eq("gmail_id", change.gmail_id),
        )
        .unique();
      if (!message) continue;
      const labelIds = applyLabelDelta(
        message.label_ids,
        change.add,
        change.remove,
      );
      touchedThreads.add(message.thread_gmail_id);
      if (sameLabels(labelIds, message.label_ids)) continue;
      await ctx.db.patch(message._id, {
        label_ids: labelIds,
        is_unread: labelIds.includes("UNREAD"),
        updated_at: now,
      });
    }

    for (const threadGmailId of touchedThreads) {
      await recomputeThread(ctx, accountId, threadGmailId);
    }
  },
});

export const markMessagesDeleted = internalMutation({
  args: {
    accountId: v.id("accounts"),
    messages: v.array(
      v.object({ gmail_id: v.string(), thread_gmail_id: v.string() }),
    ),
  },
  handler: async (ctx, { accountId, messages }) => {
    const now = Date.now();
    const touchedThreads = new Set<string>();

    for (const entry of messages) {
      // A draft message never had a row: it lives as a draft.
      await dropGmailDraft(ctx, accountId, entry.gmail_id);
      const message = await ctx.db
        .query("messages")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", accountId).eq("gmail_id", entry.gmail_id),
        )
        .unique();
      if (!message) continue;
      touchedThreads.add(message.thread_gmail_id);
      await ctx.db.patch(message._id, { deleted: true, updated_at: now });
    }

    for (const threadGmailId of touchedThreads) {
      await settleThread(ctx, accountId, threadGmailId);
    }
    await schedulePrivacyCheck(ctx, accountId, [...touchedThreads]);
  },
});

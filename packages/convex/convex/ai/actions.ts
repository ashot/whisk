"use node";

import { v } from "convex/values";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { actionAccounts, chargeAppModelCall, recordUse } from "../lib/actionAuth";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { CATEGORIES } from "@mail/shared/src/lib/categories";
import { FAST_MODEL, IMPORTANCE_MODEL, SMART_MODEL, aiConfigured, complete, completeJson } from "./llm";
import { transcriptOf } from "./mailText";
import type { ClusterCandidate } from "../clusters";
import type { JudgeRow } from "../filters";
import { MIN_TOPIC, clusterSystem, groupCandidates, parseClusterVerdict, parseThemeVerdict, themeSystem, type LooseSender, type ThemeRow, type ThemeStream } from "./grouping";
import { JUDGE_BATCH, JUDGE_SYSTEM, judgeView, parseJudgeVerdict } from "./judge";
import { IMPORTANCE_BATCH, IMPORTANCE_INBOX_PASS, IMPORTANCE_SYSTEM, importanceInput, parseImportanceVerdict, type ImportanceCorrection, type ImportanceVerdict } from "./importance";
import { MAX_IMPORTANCE_POLICY } from "@mail/shared/src/lib/importance";
import { draftSystem } from "./draft";
import { buildSuggestPrompt, sanitizeSuggestions, normalizeForMatch } from "./suggest";

// Every model call in the app, in one Node-runtime file (the Anthropic SDK
// needs Node). Data access stays in the default-runtime queries/mutations
// these actions call — this file only talks to the model.

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const CLASSIFY_BATCH = 25;

const CLASSIFY_SYSTEM = [
  "You sort email threads into lanes. The lanes:",
  ...CATEGORIES.map((c) => `- ${c.id}: ${c.hint}`),
  "- primary: none of the above — real correspondence between people, or anything you are unsure about.",
  "",
  "Input: one thread per line, formatted `id ‖ from ‖ subject ‖ snippet`.",
  'Reply with ONLY a JSON object mapping every id to a lane id, e.g. {"t1":"newsletters","t2":"primary"}.',
  "When in doubt, choose primary — a person's mail must never be filed away wrongly.",
].join("\n");

/** Classify threads the rules and heuristics left unplaced. Scheduled by the
 *  sync write path; one Haiku call covers a batch. */
export const classifyThreads = internalAction({
  args: { accountId: v.id("accounts"), threadGmailIds: v.array(v.string()) },
  handler: async (ctx, { accountId, threadGmailIds }) => {
    if (!aiConfigured() || threadGmailIds.length === 0) return { classified: 0 };
    const rows = await ctx.runQuery(
      internal.ai.classify.threadsForClassification,
      { accountId, threadGmailIds },
    );
    let classified = 0;
    for (let i = 0; i < rows.length; i += CLASSIFY_BATCH) {
      const chunk = rows.slice(i, i + CLASSIFY_BATCH);
      const user = chunk
        .map((r) => `${r.gmail_id} ‖ ${r.from} ‖ ${r.subject} ‖ ${r.snippet}`)
        .join("\n");
      const verdict = await completeJson<Record<string, string>>({
        model: FAST_MODEL,
        system: CLASSIFY_SYSTEM,
        user,
        maxTokens: 1500,
      });
      if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) throw new Error("The filter model returned an invalid verdict. Nothing from this run was applied.");
      const entries = chunk.map((r) => ({
        thread_gmail_id: r.gmail_id,
        category: verdict[r.gmail_id] ?? null,
      }));
      await ctx.runMutation(internal.ai.classify.applyCategories, {
        accountId,
        entries,
      });
      classified += entries.length;
    }
    return { classified };
  },
});

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

/** Longest steer a caller may give a draft or a rewrite, and longest draft a
 *  rewrite takes. A long email fits; a pasted document does not. */
const MAX_INSTRUCTION = 2_000;
const MAX_REWRITE_TEXT = 20_000;

export const draftReply = action({
  args: {
    token: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    threadGmailId: v.string(),
    /** Optional steer: "accept, propose Thursday", "decline politely"… */
    instruction: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ body_text: string }> => {
    const context = await ctx.runQuery(internal.ai.draft.contextForThread, {
      token: args.token,
      accountId: args.accountId,
      threadGmailId: args.threadGmailId,
    });
    await recordUse(ctx, args.token);
    if (args.instruction && args.instruction.length > MAX_INSTRUCTION) throw new Error(`Use a direction of at most ${MAX_INSTRUCTION.toLocaleString("en-US")} characters`);
    await chargeAppModelCall(ctx, args.token, context.account._id);
    const user = [
      `Subject: ${context.subject}`,
      "",
      transcriptOf(context.messages),
      "",
      args.instruction
        ? `Write the reply. Direction from ${context.account.name ?? "the owner"}: ${args.instruction}`
        : "Write the reply.",
    ].join("\n");
    const body = await complete({
      model: SMART_MODEL,
      system: draftSystem({ ...context.account, ...context }),
      user,
      maxTokens: 1200,
    });
    return { body_text: body };
  },
});

/** Predicted replies for the empty composer. Codecast's ghost: an LLM
 *  sees the thread plus the person's own sent mail and guesses what they
 *  would type next. The client only shows these while the box is empty. */
export const suggestReplies = action({
  args: {
    token: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    threadGmailId: v.string(),
  },
  handler: async (ctx, args): Promise<{ suggestions: string[]; anchor: string | null }> => {
    if (!aiConfigured()) return { suggestions: [], anchor: null };
    const context = await ctx.runQuery(internal.ai.suggest.contextForSuggest, {
      token: args.token,
      accountId: args.accountId,
      threadGmailId: args.threadGmailId,
    });
    await recordUse(ctx, args.token);
    if (context.skip) return { suggestions: [], anchor: null };
    await chargeAppModelCall(ctx, args.token, context.account_id);
    const parsed = await completeJson<unknown>({
      model: FAST_MODEL,
      system: "You predict the next email this person would send. Return JSON only.",
      user: buildSuggestPrompt({
        who: context.who,
        subject: context.subject,
        transcript: context.transcript,
        sent: context.sent,
        style: context.style,
        preferences: context.preferences,
        contacts: context.contacts,
        signature: context.signature,
      }),
      maxTokens: 1200,
      effort: "low",
    });
    const banned = new Set<string>(context.sent.map(normalizeForMatch));
    return { suggestions: sanitizeSuggestions(parsed, banned), anchor: context.anchor };
  },
});

/** Rewrite compose text in place: shorter, friendlier, or any instruction. */
export const rewrite = action({
  args: {
    token: v.optional(v.string()),
    text: v.string(),
    instruction: v.string(),
  },
  handler: async (ctx, { token, text, instruction }): Promise<{ text: string }> => {
    // The rewrite needs no rows, but must not be an open proxy: the caller
    // needs a mailbox, the input is bounded, and each call is a hand-started
    // model call on that mailbox's hourly budget.
    const [account] = await actionAccounts(ctx, { token, scope: "mail.draft" });
    if (!account) throw new Error("Unauthorized: no connected accounts");
    if (text.length > MAX_REWRITE_TEXT) throw new Error(`Use a draft of at most ${MAX_REWRITE_TEXT.toLocaleString("en-US")} characters`);
    if (instruction.length > MAX_INSTRUCTION) throw new Error(`Use an instruction of at most ${MAX_INSTRUCTION.toLocaleString("en-US")} characters`);
    await ctx.runMutation(internal.ai.filterSupport.takeModelBudget, { accountId: account._id, cost: 1 });
    const out = await complete({
      model: SMART_MODEL,
      system: [
        "You revise email drafts. Apply the instruction to the draft.",
        "Keep the writer's voice and intent. Plain text only.",
        "Output ONLY the revised draft, nothing else.",
      ].join("\n"),
      user: `Instruction: ${instruction}\n\nDraft:\n${text}`,
      maxTokens: 1200,
    });
    return { text: out };
  },
});

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

const SUMMARY_PROMPT = {
  thread: [
    "You summarize an email thread for its owner, who has not read it.",
    "Write 2–4 short plain sentences: what happened, what was decided, and what (if anything) now needs the owner. Name people by first name.",
    "No preamble, no bullet points, no 'this thread'.",
  ],
  latest: [
    "You tell the owner of a mailbox what an email that just arrived says, for its notification.",
    "Write 1–2 short plain sentences: what the sender says or asks, and what (if anything) it needs from the owner. Name people by first name.",
    "No preamble, no bullet points, no 'this email'.",
  ],
};

/** The thread's summary, or with `latest` just its newest message's, from
 *  the cache when no mail has landed since. The thread view reads the whole
 *  thread; new-mail notifications on every device share the latest one. */
async function summarize(
  ctx: ActionCtx,
  args: {
    token?: string;
    accountId?: Id<"accounts">;
    threadGmailId: string;
    system?: boolean;
    timeoutMs?: number;
    latest?: boolean;
  },
): Promise<string> {
  const context = await ctx.runQuery(internal.ai.summarize.summaryContext, {
    token: args.token,
    accountId: args.accountId,
    threadGmailId: args.threadGmailId,
    system: args.system,
    latest: args.latest,
  });
  await recordUse(ctx, args.token);
  if (context.cached) return context.cached;
  await chargeAppModelCall(ctx, args.token, context.account_id);

  const summary = await complete({
    model: FAST_MODEL,
    system: SUMMARY_PROMPT[args.latest ? "latest" : "thread"].join("\n"),
    user: `Subject: ${context.subject}\n\n${transcriptOf(context.messages, { lastN: 12, perMessage: 900 })}`,
    maxTokens: 300,
    timeoutMs: args.timeoutMs,
  });
  await ctx.runMutation(internal.ai.summarize.storeSummary, {
    accountId: context.account_id,
    threadGmailId: args.threadGmailId,
    summary,
    messageCount: context.message_count ?? context.messages.length,
    latest: args.latest,
  });
  return summary;
}

export const summarizeThread = action({
  args: {
    token: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    threadGmailId: v.string(),
    /** A notification waiting on it: give up rather than hold the banner. */
    timeoutMs: v.optional(v.number()),
    /** Only the newest message, as a notification announces it. */
    latest: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ summary: string }> => ({ summary: await summarize(ctx, args) }),
});

/** Summaries of each thread's newest message for new-mail pushes, in
 *  parallel. A thread the model cannot summarize in time is left out, and its
 *  push shows the message opening. */
export const summarizeForPush = internalAction({
  args: { accountId: v.id("accounts"), threadGmailIds: v.array(v.string()), timeoutMs: v.number() },
  handler: async (ctx, { accountId, threadGmailIds, timeoutMs }): Promise<Record<string, string>> => {
    if (!aiConfigured()) return {};
    const out: Record<string, string> = {};
    await Promise.all(
      threadGmailIds.map(async (threadGmailId) => {
        try {
          out[threadGmailId] = await summarize(ctx, { accountId, threadGmailId, system: true, timeoutMs, latest: true });
        } catch (e) {
          console.warn("[push] summary skipped", { threadGmailId, error: String(e) });
        }
      }),
    );
    return out;
  },
});

// ---------------------------------------------------------------------------
// Voice profile
// ---------------------------------------------------------------------------

export const buildStyleProfile = internalAction({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    if (!aiConfigured()) return { built: false };
    const samples: string[] = await ctx.runQuery(internal.ai.profile.sentSamples, {
      accountId,
    });
    if (samples.length < 3) return { built: false };

    const observations = await completeJson<string[]>({
      model: SMART_MODEL,
      system: [
        "You study how one person writes email and distill their voice.",
        "From the samples, produce 3–6 observations another writer could follow to pass as them: tone, typical length, how they open, how they sign off, punctuation habits, phrases they reach for.",
        "Each observation is one plain sentence about HOW they write — never about what any particular email said.",
        'Reply with ONLY a JSON array of strings, e.g. ["Opens with the first name, no greeting word", "Signs off with just — N"].',
      ].join("\n"),
      user: samples.map((s, i) => `Sample ${i + 1}:\n${s}`).join("\n\n———\n\n"),
      maxTokens: 700,
    });
    if (!observations || observations.length === 0) return { built: false };

    await ctx.runMutation(internal.ai.profile.replaceStyleMemories, {
      accountId,
      texts: observations
        .filter((t) => typeof t === "string" && t.trim())
        .slice(0, 6),
    });
    return { built: true, memories: observations.length };
  },
});

// ---------------------------------------------------------------------------
// Topic clustering
// ---------------------------------------------------------------------------

/** Threads per model pass. Big enough for a topic to show itself, small
 *  enough that one bad answer loses little. */
const CLUSTER_BATCH = 160;
/** Passes per run; a fresh regroup of a large inbox takes several. */
const CLUSTER_MAX_PASSES = 12;
/** How far back a pass re-offers threads it once left unclustered, so a
 *  topic can form from mail that arrived one thread at a time. */
const CLUSTER_REVISIT_MS = 21 * 24 * 3600 * 1000;
/** A batch of 160 threads can take the model a couple of minutes to answer
 *  in full. An action runs at most three batches plus the theme call, so
 *  even the worst case stays inside Convex's ten-minute action limit. */
const CLUSTER_CALL_TIMEOUT_MS = 150_000;
const CLUSTER_BATCHES_PER_ACTION = 3;

type ClusterRoster = {
  clusters: Array<{ _id: string; name: string; description: string; pinned: boolean; size: number; source: string; created_at: number; updated_at: number }>;
  preferences: string[];
  enabled: boolean;
  granularity: "fewer" | "balanced" | "more";
};

/**
 * One clustering run for an account: assign unjudged inbox threads to the
 * topics that exist, let new topics form, repeat until the batch runs dry.
 * Scheduled (debounced) by the sync write path; a regroup gesture schedules
 * it with `fresh`, which reconsiders model placements but keeps manual ones.
 */
export const clusterInbox = internalAction({
  args: {
    accountId: v.id("accounts"), fresh: v.boolean(),
    continuation: v.optional(v.object({ startedAt: v.number(), pending: v.array(v.string()), remaining: v.array(v.string()), review: v.boolean(), done: v.number(), total: v.number(), created: v.number(), skipped: v.optional(v.number()), revisit: v.optional(v.boolean()) })),
  },
  handler: async (ctx, { accountId, fresh, continuation }): Promise<{ passes: number; created?: number; placed?: number }> => {
    const begun = await ctx.runMutation(internal.clusters.beginPass, { accountId, startedAt: continuation?.startedAt });
    const { ok, startedAt } = begun;
    const revisit = continuation ? !!continuation.revisit : begun.revisit;
    if (!ok) {
      await ctx.runMutation(internal.clusters.finishPass, { accountId, startedAt: continuation?.startedAt ?? 0 });
      return { passes: 0 };
    }
    if (!aiConfigured()) {
      await ctx.runMutation(internal.clusters.finishPass, { accountId, startedAt, error: "AI is not configured" });
      return { passes: 0 };
    }
    let passes = 0, created = continuation?.created ?? 0, placed = 0, skipped = continuation?.skipped ?? 0;
    try {
      const candidates: ClusterCandidate[] = await ctx.runQuery(internal.clusters.candidates, {
        accountId, limit: CLUSTER_BATCH * CLUSTER_MAX_PASSES, fresh: continuation ? true : fresh,
        only: continuation?.pending,
        revisitSince: fresh || !revisit ? undefined : Date.now() - CLUSTER_REVISIT_MS,
      });
      let pending = groupCandidates(candidates);
      let remaining = continuation?.remaining ?? [];
      let review = continuation?.review ?? false;
      // Progress: threads read so far out of the ones this run set out to
      // read. The second look re-reads what the first left without a topic,
      // and counts from zero again over that smaller set.
      let done = continuation?.done ?? 0;
      let total = continuation?.total ?? pending.length;
      if (!continuation) await ctx.runMutation(internal.clusters.noteProgress, { accountId, startedAt, progress: { done, total, review } });
      for (; passes < CLUSTER_BATCHES_PER_ACTION; passes++) {
        // The second look only pays when the first could have changed
        // something: a topic was made, or the batch was too big for one call.
        if (!pending.length && !review && remaining.length && (created > 0 || total > CLUSTER_BATCH)) {
          const rows: ClusterCandidate[] = await ctx.runQuery(internal.clusters.candidates, { accountId, limit: remaining.length, fresh: true, only: remaining });
          pending = groupCandidates(rows);
          remaining = [];
          review = true;
          done = 0;
          total = pending.length;
          await ctx.runMutation(internal.clusters.noteProgress, { accountId, startedAt, progress: { done, total, review } });
        }
        if (!pending.length) break;
        const roster: ClusterRoster = await ctx.runQuery(internal.clusters.roster, { accountId });
        if (!roster.enabled) break;
        const batch = pending.slice(0, CLUSTER_BATCH);
        const topics = fresh ? roster.clusters.filter(c => c.pinned || c.source === "user" || c.updated_at >= startedAt) : roster.clusters;
        pending = pending.slice(CLUSTER_BATCH);
        done += batch.length;
        // One bad or slow answer costs one batch, never the run: on the first
        // look its threads go to the second look; on the second look they
        // stay as they were and the run says how many.
        let parsed: ReturnType<typeof parseClusterVerdict>;
        try {
          const verdict = await completeJson<unknown>({
            model: SMART_MODEL, system: clusterSystem(roster),
            user: JSON.stringify({ topics, threads: batch.map((t, i) => ({ ...t, cluster_id: undefined, gmail_id: String(i) })) }),
            maxTokens: 10000, effort: "medium", timeoutMs: CLUSTER_CALL_TIMEOUT_MS,
          });
          parsed = parseClusterVerdict(verdict, batch, topics, MIN_TOPIC[roster.granularity]);
        } catch (error) {
          console.error("Grouping batch skipped", error);
          if (review) skipped += batch.length;
          else remaining.push(...batch.map(t => t.gmail_id));
          await ctx.runMutation(internal.clusters.noteProgress, { accountId, startedAt, progress: { done, total, review } });
          continue;
        }
        const result: { created: number; placed: number } = await ctx.runMutation(internal.clusters.applyPass, { accountId, startedAt, progress: { done, total, review }, ...parsed });
        created += result.created;
        placed += result.placed;
        if (!review) remaining.push(...parsed.assignments.filter(a => !a.target).map(a => a.thread_gmail_id));
      }
      if (pending.length || (!review && remaining.length && (created > 0 || total > CLUSTER_BATCH))) {
        await ctx.runMutation(internal.clusters.continuePass, { accountId, fresh, startedAt, pending: pending.map(t => t.gmail_id), remaining, review, done, total, created, skipped, revisit });
      } else {
        // The run read mail one batch at a time; now look at the whole
        // topic list once and say which topics belong together. That call
        // gets an action of its own, so its time is not the batches' time.
        // It is worth paying for when a stream was made, on a fresh regroup,
        // and on the revisit pass a few times a day; mail that only joined
        // streams that already sit in themes changes nothing above them.
        await ctx.runMutation(internal.clusters.startThemes, { accountId, startedAt, changed: created > 0 || fresh || (revisit && total > 0), error: skipped > 0 ? `The model did not answer for ${skipped} conversations, so they are still without a topic. They will be read again on the next pass, or regroup now.` : undefined });
      }
    } catch (error) {
      console.error("Clustering failed", error);
      await ctx.runMutation(internal.clusters.finishPass, { accountId, startedAt, error: "Grouping could not finish. Your existing topics are kept. Try again." });
      throw error;
    }
    return { passes, created, placed };
  },
});

/** The theme pass has a whole action to itself: one call over every topic
 *  side by side can take a few minutes on a large inbox. */
const THEME_CALL_TIMEOUT_MS = 420_000;

/**
 * One model call over every topic side by side: which themes exist, which
 * topic sits in which, which topics are one thing under two names. Runs
 * after a run that read anything, and on a mailbox that has topics but no
 * themes yet. A bad verdict is dropped whole and said on the account;
 * topics stay as they are.
 */
export const themeInbox = internalAction({
  args: { accountId: v.id("accounts"), startedAt: v.number(), changed: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { accountId, startedAt, changed, error }): Promise<void> => {
    let failure: string | undefined;
    try {
      const roster: { themes: ThemeRow[]; topics: ThemeStream[]; senders: LooseSender[]; preferences: string[]; enabled: boolean } = await ctx.runQuery(internal.clusters.themeRoster, { accountId });
      const topics = roster.topics.filter(t => t.size > 0 || t.mine);
      if (roster.enabled && topics.length >= 2 && (changed || roster.themes.length === 0)) {
        await ctx.runMutation(internal.clusters.noteProgress, { accountId, startedAt, progress: { done: topics.length, total: topics.length, review: true, tidy: true } });
        // Short ids in both directions: the model reads and writes "12",
        // not a 32-character row id, so the answer stays small.
        const themes = roster.themes.map((t, i) => ({ ...t, _id: `T${i}` }));
        const streams = topics.map((t, i) => ({ ...t, _id: String(i), parent_id: t.parent_id ? `T${roster.themes.findIndex(x => x._id === t.parent_id)}` : undefined }));
        const senders = roster.senders.map((s, i) => ({ ...s, key: `s${i}` }));
        const verdict = await completeJson<unknown>({
          model: SMART_MODEL, system: themeSystem(roster),
          user: JSON.stringify({
            themes: themes.map(t => ({ id: t._id, name: t.name, description: t.description, size: t.size, mine: t.mine || undefined })),
            topics: streams.map(t => ({ id: t._id, name: t.name, description: t.description, size: t.size, senders: t.senders, lanes: t.lanes, samples: t.samples, mine: t.mine || undefined, theme: t.parent_id && t.parent_id !== "T-1" ? t.parent_id : undefined })),
            senders: senders.map(s => ({ key: s.key, name: s.name, size: s.size, lane: s.lane, samples: s.samples })),
          }),
          maxTokens: 12000, effort: "medium", timeoutMs: THEME_CALL_TIMEOUT_MS,
        });
        if (verdict === null) throw new Error("The model's answer was not readable");
        const parsed = parseThemeVerdict(verdict, { themes, topics: streams, senders });
        const themeId = (id: string) => roster.themes[Number(id.slice(1))]._id;
        const topicId = (id: string) => topics[Number(id)]._id;
        const senderKey = (key: string) => roster.senders[Number(key.slice(1))].key;
        await ctx.runMutation(internal.clusters.applyThemes, {
          accountId, startedAt,
          themes: parsed.themes.map(t => ({ ...t, id: t.id ? themeId(t.id) : undefined, topics: t.topics.map(topicId), senders: t.senders.map(senderKey) })),
          merges: parsed.merges.map(m => ({ ...m, into: topicId(m.into), from: m.from.map(topicId) })),
        });
      }
    } catch (err) {
      console.error("Theme pass failed; topics kept as grouped", err);
      failure = "Whisk could not sort the topics into themes this time; they are kept as they are. Regroup to try again.";
    }
    await ctx.runMutation(internal.clusters.finishPass, { accountId, startedAt, error: error ?? failure });
  },
});

// ---------------------------------------------------------------------------
// Natural-language filters
// ---------------------------------------------------------------------------

const FILTER_ACTIONS_HELP = [
  "- archive: out of the inbox",
  "- trash: to the trash",
  "- star",
  "- read: mark as read",
  '- label: add a Gmail label (arg: the label name — only one the person already has)',
  `- lane: file under a lane (arg: one of ${CATEGORIES.map((c) => c.id).join(", ")}, or primary)`,
  "- cluster: put in a topic (arg: the exact name of one of the person's topics when the sentence names or clearly means one; otherwise a new short name, 2 to 4 words)",
].join("\n");

type ParsedFilter = { condition?: string; actions?: unknown; error?: string };

/**
 * Turn one sentence into a filter the judge can apply: a self-contained
 * condition and a fixed action list. Nothing is saved here — the client
 * shows the reading back (and a dry run) before it dispatches saveFilter.
 */
export const parseFilter = action({
  args: {
    token: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    text: v.string(),
  },
  handler: async (
    ctx,
    { token, accountId, text },
  ): Promise<{ condition: string; actions: Array<{ kind: string; arg?: string }> }> => {
    const [account] = await actionAccounts(ctx, { token, accountId, scope: "mail.organize" });
    if (!account) throw new Error("Unauthorized: no connected accounts");
    if (!text.trim() || text.length > 2000) throw new Error("Use a filter sentence of at most 2,000 characters");
    await ctx.runMutation(internal.ai.filterSupport.takeModelBudget, { accountId: account._id, cost: 1 });
    const { labels, topics }: { labels: string[]; topics: string[] } = await ctx.runQuery(internal.ai.filterSupport.labelNames, {
      accountId: account._id,
    });
    const parsed = await completeJson<ParsedFilter>({
      model: SMART_MODEL,
      system: [
        "You turn one sentence a person wrote about their mail into a filter: a condition (which threads it applies to, restated in plain complete words so it can be judged on its own later) and the actions to take on them.",
        "",
        "The condition is later judged by a reader who sees only, for each thread: the sender's name and address, the recipients, the lane it was filed under (newsletters, notifications, receipts, travel, calendar, promotions, security, social, or primary), the subject, the readable body of the newest message from someone other than the person, whether it has attachments, and how many messages it holds. Write the condition in those terms. It cannot depend on a thread's age or date, whether it was read or replied to, who is in the person's contacts, or anything outside the thread; if the sentence needs such a fact, reply with an error saying what the filter cannot see, and suggest a wording it can judge.",
        "",
        "Allowed actions:",
        FILTER_ACTIONS_HELP,
        "",
        "One filter is one condition and one action list applied to every matching thread. If the sentence gives different actions for different mail, reply with an error asking for one filter at a time.",
        "Never invent an action. If no supported action was explicitly requested, return an error asking the person to include one, such as star, archive or put in a named topic.",
        "Keep the condition faithful to what was written — do not widen or narrow it. If the sentence asks for something outside the allowed actions, or for a label the person does not have, reply with {\"error\": \"<one plain sentence>\"} instead.",
        'Reply with ONLY JSON: {"condition": "…", "actions": [{"kind": "…", "arg": "…"}]}.',
      ].join("\n"),
      user: `Labels the person has: ${labels.length ? labels.join(", ") : "(none)"}\nTopics the person has: ${topics.length ? topics.join(", ") : "(none)"}\n\nSentence: ${text}`,
      maxTokens: 600,
      effort: "low",
    });
    if (!parsed) throw new Error("Could not read that as a filter");
    if (parsed.error) throw new Error(parsed.error);
    if (typeof parsed.condition !== "string" || !parsed.condition.trim()) {
      throw new Error("Could not read that as a filter");
    }
    const actions: Array<{ kind: string; arg?: string }> = await ctx.runQuery(
      internal.ai.filterSupport.checkActions,
      { accountId: account._id, actions: parsed.actions },
    );
    return { condition: parsed.condition.trim(), actions };
  },
});

type JudgeInput = { _id: string; condition: string };

/** One judging call: which of `filters` does each row satisfy. */
async function judgeRows(
  owner: string,
  filters: JudgeInput[],
  rows: JudgeRow[],
  /** Called after each validated batch, so an earlier batch's verdicts land
   *  even when a later one comes back bad. */
  onBatch?: (hits: Array<{ filter_id: string; thread_gmail_id: string }>) => Promise<void>,
): Promise<Array<{ filter_id: string; thread_gmail_id: string }>> {
  const all: Array<{ filter_id: string; thread_gmail_id: string }> = [];
  for (let i = 0; i < rows.length; i += JUDGE_BATCH) {
    const chunk = rows.slice(i, i + JUDGE_BATCH);
    const verdict = await completeJson<Record<string, unknown>>({
      model: SMART_MODEL, system: JUDGE_SYSTEM,
      user: JSON.stringify({ owner, filters: filters.map((f, i) => ({ id: `f${i}`, condition: f.condition })), threads: chunk.map(judgeView) }),
      maxTokens: 4000, effort: "low", timeoutMs: 45_000,
    });
    const hits: Array<{ filter_id: string; thread_gmail_id: string }> = [];
    for (const [j, hit] of parseJudgeVerdict(verdict, chunk.length, filters.length).entries()) {
      for (const f of hit) hits.push({ filter_id: filters[f]._id, thread_gmail_id: chunk[j].gmail_id });
    }
    if (onBatch) await onBatch(hits);
    all.push(...hits);
  }
  return all;
}

async function readJudgeRows(ctx: ActionCtx, accountId: Id<"accounts">, ids?: string[], limit = 200): Promise<JudgeRow[]> {
  const threadIds: string[] = ids ?? await ctx.runQuery(internal.filters.inboxIds, { accountId, limit });
  const rows: JudgeRow[] = [];
  for (let i = 0; i < threadIds.length; i += JUDGE_BATCH) {
    rows.push(...await ctx.runQuery(internal.filters.threadsForJudging, { accountId, threadGmailIds: threadIds.slice(i, i + JUDGE_BATCH) }));
  }
  return rows;
}

/** Dry run: which recent inbox threads a condition would match right now.
 *  Nothing is changed. */
export const previewFilter = action({
  args: {
    token: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    condition: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { token, accountId, condition, limit }): Promise<string[]> => {
    // The dry run reads the inbox to answer whether each thread matches a
    // free-form condition, so it is a read of mail as well as organizing.
    const [account] = await actionAccounts(ctx, { token, accountId, scope: ["mail.read", "mail.organize"] });
    if (!account) throw new Error("Unauthorized: no connected accounts");
    if (!aiConfigured()) throw new Error("AI is not configured on this deployment");
    if (!condition.trim() || condition.length > 2000) throw new Error("Use a condition of at most 2,000 characters");
    await ctx.runMutation(internal.ai.filterSupport.takeModelBudget, { accountId: account._id, cost: 1 });
    const owner: string = await ctx.runQuery(internal.ai.filterSupport.ownerAddress, { accountId: account._id });
    const rows = await readJudgeRows(ctx, account._id, undefined, Math.min(limit ?? 200, 400));
    const hits = await judgeRows(owner, [{ _id: "f", condition }], rows);
    return hits.map((h) => h.thread_gmail_id);
  },
});

/**
 * Judge threads against the account's enabled filters and act on the hits.
 * The sync path schedules it for new inbound threads; "run on the inbox"
 * calls it with no ids (the recent inbox) and one filter.
 */
export const judgeFilters = internalAction({
  args: {
    accountId: v.id("accounts"),
    threadGmailIds: v.optional(v.array(v.string())),
    filterIds: v.optional(v.array(v.id("filters"))),
    includeOlder: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { accountId, threadGmailIds, filterIds, includeOlder },
  ): Promise<{ applied: number }> => {
    if (!aiConfigured()) return { applied: 0 };
    const filters: Array<JudgeInput & { revision: number }> = await ctx.runQuery(internal.filters.enabledFilters, {
      accountId,
      only: filterIds,
    });
    if (filters.length === 0) return { applied: 0 };
    try {
      const owner: string = await ctx.runQuery(internal.ai.filterSupport.ownerAddress, { accountId });
      const rows = await readJudgeRows(ctx, accountId, threadGmailIds, 300);
      const byGmail = new Map(rows.map(r => [r.gmail_id, r]));
      let applied = 0;
      await judgeRows(owner, filters, rows, async (hits) => {
        for (let i = 0; i < hits.length; i += 10) {
          const result: { applied: number } = await ctx.runMutation(internal.filters.applyHits, {
            accountId, includeOlder,
            hits: hits.slice(i, i + 10).map(h => ({
              filter_id: h.filter_id as Id<"filters">,
              thread_gmail_id: h.thread_gmail_id,
              revision: filters.find(f => f._id === h.filter_id)!.revision,
              message_count: byGmail.get(h.thread_gmail_id)!.message_count,
              inbound_at: byGmail.get(h.thread_gmail_id)!.inbound_at,
              last_at: byGmail.get(h.thread_gmail_id)!.last_at,
            })),
          });
          applied += result.applied;
        }
      });
      await ctx.runMutation(internal.filters.recordCheck, { accountId, filters: filters.map(f => ({ id: f._id as Id<"filters">, revision: f.revision })), failed: false });
      return { applied };
    } catch (error) {
      console.error("Filter check failed", error);
      await ctx.runMutation(internal.filters.recordCheck, { accountId, filters: filters.map(f => ({ id: f._id as Id<"filters">, revision: f.revision })), failed: true });
      throw error;
    }
  },
});

// ---------------------------------------------------------------------------
// Importance
// ---------------------------------------------------------------------------

type JudgeContext = { owner: string; policy: string; revision: number; corrections: ImportanceCorrection[] };

const IMPORTANCE_CONCURRENCY = 6;

/** Run `work` over items at most `limit` at a time, settling each. */
async function settleInWaves<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: "fulfilled", value: await work(items[i]) }; } catch (reason) { out[i] = { status: "rejected", reason }; }
    }
  }));
  return out;
}

/** Judge rows against a policy in batches, all at once. A bad batch throws
 *  after the good ones have been handed to `onBatch`. */
async function judgeImportanceRows(
  context: Omit<JudgeContext, "revision">,
  rows: JudgeRow[],
  onBatch?: (verdicts: Array<{ row: JudgeRow } & ImportanceVerdict>) => Promise<void>,
): Promise<Array<{ row: JudgeRow } & ImportanceVerdict>> {
  const batches: JudgeRow[][] = [];
  for (let i = 0; i < rows.length; i += IMPORTANCE_BATCH) batches.push(rows.slice(i, i + IMPORTANCE_BATCH));
  // A few calls at a time: a whole-inbox pass is dozens of batches.
  const settled = await settleInWaves(batches, IMPORTANCE_CONCURRENCY, async (batch) => {
    const verdict = await completeJson<unknown>({
      model: IMPORTANCE_MODEL,
      system: IMPORTANCE_SYSTEM,
      user: importanceInput({ ...context, rows: batch }),
      maxTokens: 8000,
      effort: "low",
      timeoutMs: 60_000,
    });
    const judged = parseImportanceVerdict(verdict, batch.length).map((v, i) => ({ row: batch[i], ...v }));
    if (onBatch) await onBatch(judged);
    return judged;
  });
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) throw failure.reason;
  return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

/**
 * Judge threads against the person's importance policy and land the
 * verdicts. The sync path schedules it for threads with new inbound mail; a
 * policy save or a first pass calls it with no ids (the recent inbox).
 */
export const judgeImportance = internalAction({
  args: {
    accountId: v.id("accounts"),
    threadGmailIds: v.optional(v.array(v.string())),
    /** With no ids: how many of the newest inbox threads to judge. */
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { accountId, threadGmailIds, limit }): Promise<{ applied: number }> => {
    if (!aiConfigured()) return { applied: 0 };
    const context: JudgeContext = await ctx.runQuery(internal.importance.judgeContext, { accountId });
    const rows = await readJudgeRows(ctx, accountId, threadGmailIds, limit ?? IMPORTANCE_INBOX_PASS);
    let applied = 0;
    await judgeImportanceRows(context, rows, async (verdicts) => {
      const result: { applied: number } = await ctx.runMutation(internal.importance.applyImportance, {
        accountId,
        revision: context.revision,
        verdicts: verdicts.map((v) => ({
          thread_gmail_id: v.row.gmail_id,
          important: v.important,
          why: v.why,
          message_count: v.row.message_count,
          last_at: v.row.last_at,
        })),
      });
      applied += result.applied;
    });
    return { applied };
  },
});

/** Dry run of a draft policy over the recent inbox: every verdict, nothing
 *  changed. The client compares them with what each thread shows now. */
export const previewImportance = action({
  args: {
    token: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    policy: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { token, accountId, policy, limit }): Promise<Array<{ thread_gmail_id: string; important: boolean; why: string }>> => {
    const [account] = await actionAccounts(ctx, { token, accountId, scope: ["mail.read", "mail.organize"] });
    if (!account) throw new Error("Unauthorized: no connected accounts");
    if (!aiConfigured()) throw new Error("AI is not configured on this deployment");
    if (!policy.trim() || policy.length > MAX_IMPORTANCE_POLICY) throw new Error(`Use a policy of at most ${MAX_IMPORTANCE_POLICY.toLocaleString("en-US")} characters`);
    const rows = await readJudgeRows(ctx, account._id, undefined, Math.min(limit ?? 150, IMPORTANCE_INBOX_PASS));
    await ctx.runMutation(internal.ai.filterSupport.takeModelBudget, { accountId: account._id, cost: Math.ceil(rows.length / IMPORTANCE_BATCH) });
    const context: JudgeContext = await ctx.runQuery(internal.importance.judgeContext, { accountId: account._id });
    const verdicts = await judgeImportanceRows({ ...context, policy }, rows);
    return verdicts.map((v) => ({ thread_gmail_id: v.row.gmail_id, important: v.important, why: v.why }));
  },
});

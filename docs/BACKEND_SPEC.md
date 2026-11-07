# packages/convex — mail backend

Convex is the sync layer between clients and Gmail. Gmail is the system of record for
mail data; Convex rows are a cached, synced projection plus an outbound op queue.
Dev runs against `npx convex dev` (local anonymous deployment) — no cloud account needed.

## Auth model

Token auth, no third-party auth dependency. An `auth_sessions` row maps a random token
(sha256-hashed at rest) to an account. Tokens are minted in exactly two places:
- `demo.seed` mutation — creates a `provider: "demo"` account, seeds fixtures, returns a token.
- Gmail OAuth callback (http action) — creates/updates a `provider: "gmail"` account, returns
  the token to the opener via postMessage page.
Every public query/mutation takes `token` and resolves the account or throws. A small
`requireAccount(ctx, token)` helper owns this.

## Schema (convex/schema.ts)

- `accounts`: email, name?, picture?, provider ("gmail"|"demo"), history_id?, sync_status
  ("idle"|"backfilling"|"syncing"|"error"), sync_error?, last_synced_at?, updated_at.
  Index by_email.
- `auth_sessions`: account_id, token_hash, created_at, last_seen_at. Index by_token_hash.
- `credentials`: account_id, access_token, refresh_token, expiry. Index by_account.
  NEVER returned by any query.
- `labels`: account_id, gmail_id, name, kind ("system"|"user"), color?, updated_at, deleted?.
  Index by_account ["account_id","updated_at"], by_account_gmail.
- `threads`: account_id, gmail_id, subject, snippet, participants [{name?, email}],
  message_count, last_at, label_ids (gmail label id strings), is_unread, is_starred,
  has_attachments, updated_at, deleted?. Indexes: by_account_last ["account_id","last_at"],
  by_account_updated, by_account_gmail.
- `messages`: account_id, thread_gmail_id, gmail_id, from {name?, email}, to[], cc[], bcc[],
  reply_to?, date, snippet, body_html?, body_text?, label_ids, is_unread, attachments
  [{filename, mime_type, size, gmail_attachment_id}], header_message_id?, in_reply_to?,
  references?, updated_at, deleted?. Indexes: by_account_thread ["account_id",
  "thread_gmail_id", "date"], by_account_gmail, by_account_updated.
- `outbound`: account_id, kind ("modify"|"send"), payload (v.any()), status
  ("queued"|"inflight"|"done"|"error"), error?, attempts, created_at, updated_at.
  Index by_account_status.
- `drafts`: account_id, client_id (client-generated stable id), thread_gmail_id?, to[], cc[],
  bcc[], subject, body_text, reply_to_gmail_id?, mode ("new"|"reply"|"replyAll"|"forward"),
  updated_at, deleted?. Index by_account ["account_id","updated_at"], by_account_client.

All list payloads sent to clients must strip account_id (client is single-account-scoped
per token) — keep rows lean; body_html can be large so `listThreads` NEVER includes bodies.

## Client-facing functions

- `sync.listThreads({token, limit=1000})` — recent threads by last_at desc. Client syncs
  as delta overlay.
- `sync.listLabels({token})`
- `sync.getAccount({token})` — account singleton (safe fields only).
- `sync.threadMessages({token, threadGmailId})` — full messages for one thread, date asc.
- `search.searchThreads({token, q, limit=50})` — server search over the synced projection:
  subject, participants, snippet. Grammar in `@mail/shared/src/lib/searchQuery` (free text,
  from:, to:, label:, is:unread, is:starred, has:attachment); the client live filter uses
  the same module.
- `search.runFullSearch({token, q, accountId?, cursor?})` — one page of Gmail's own results
  (50 per account), imported into the projection and returned as `{rows, cursor}` in Gmail's
  rank order. The cursor is opaque (per-account Gmail page tokens); null means drained.
  Clients page on their own until a screen is full, then on scroll. Demo accounts answer
  from `searchThreads` in one page.
- `dispatch.dispatch({token, action, args, patches?, result?})` — mirrors codecast's
  contract. TABLE_CONFIG: `client_state` singleton (per-account UI prefs bag, LWW
  stamped). Named side effects:
  - `applyThreadOps({ops: [{thread_gmail_ids, add_label_ids, remove_label_ids}]})` —
    apply to threads+messages rows, insert ONE outbound modify row per op batch,
    schedule pump. Archive/trash/read/star/spam are all this one primitive.
  - `sendMessage({client_id, to, cc, bcc, subject, body_text, reply_to_gmail_id?,
    thread_gmail_id?})` — dedup on client_id; demo: append a sent message+thread row
    immediately; gmail: insert outbound send row, schedule pump; optimistic thread
    update either way.
  - `saveDraft({client_id, ...fields})` / `deleteDraft({client_id})` — upsert by
    (account, client_id).
  - `markSpam`, `deleteForever` — sugar over thread ops where gmail semantics differ.

## Gmail engine (convex/gmail/)

- `oauth.ts` http routes: GET `/gmail/auth` → 302 to Google consent (scopes:
  gmail.modify, userinfo.email, userinfo.profile; access_type=offline, prompt=consent);
  GET `/gmail/oauth/callback` → exchange code, upsert account+credentials, mint token,
  respond with tiny HTML that postMessages `{token}` to opener and closes. Client env
  vars GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET/OAUTH_REDIRECT_URL read from Convex env.
- `api.ts` — thin fetch client for Gmail REST: token refresh (single-flight per account),
  threads.list/get, messages.get (format=full), history.list, messages.modify (batch),
  messages.send (RFC 2822 via a small MIME builder, base64url). Parse payloads:
  walk parts for text/plain + text/html, collect attachment parts, decode headers
  (RFC 2047 not needed — Gmail API returns decoded headers).
- `sync.ts` actions: `backfill(accountId)` — page threads.list (maxResults 100, up to
  500 threads or 90 days), for each: threads.get, upsert thread + messages rows (bodies
  included), then store profile historyId, sync_status idle. `incremental(accountId)` —
  history.list since history_id; apply messageAdded/Deleted/labelsAdded/Removed;
  on 404 (stale historyId) fall back to backfill. Cron every 2 min for gmail accounts;
  also a public `sync.refresh({token})` mutation that schedules incremental (client
  calls on focus).
- `pump.ts` action: process queued outbound rows for an account in ts order —
  modify → messages.batchModify per thread's message ids; send → messages.send with
  threadId when replying; write back real gmail ids to the sent message/thread rows
  (the client's optimistic rows use client ids; the sync overlay supersedes them via
  altKey `client_id` on messages... keep client_id on rows created from sends so the
  client stub rekeys). Retry with attempts cap 5, status error + sync_error surfaced on
  the account row after that.

Body sanitization: DO store raw body_html from Gmail — sanitization is a CLIENT rendering
concern (DOMPurify + sandboxed iframe). Demo bodies are authored clean.

## Fixtures (convex/demo.ts)

`seed` builds a believable working mailbox — this is the primary dev/verify surface and
the first-run experience. Requirements:
- ~55 threads with real-feeling content (no lorem ipsum): a hiring loop with a recruiter,
  a multi-person product debate spanning 8 messages, a flight receipt + check-in reminder
  pair, newsletters (with restrained clean HTML bodies), GitHub-style notification threads,
  a landlord thread, an invoice with attachment metadata, cold outreach, a security alert,
  calendar invites, one thread in Spanish. Senders get consistent identities across threads.
- Timestamps spread over 45 days, weighted to recent; several unread in inbox, 2 starred,
  a couple already archived (no INBOX label), 3 in trash, 2 spam, 6 sent threads, 2 drafts.
- System labels: INBOX, STARRED, SENT, DRAFT, TRASH, SPAM, UNREAD + user labels
  ("Receipts", "Travel", "Newsletters" with colors) applied plausibly.
- Deterministic ids (`demo-thread-01` etc.) so tests can reference them; timestamps
  relative to Date.now() at seed time.

## Tests (convex-test or plain bun where possible)

- token auth: bad token throws; demo seed → account queryable.
- applyThreadOps: archive removes INBOX from thread+messages, outbound row created,
  is_unread/is_starred derived correctly; batch ops.
- sendMessage dedup on client_id; reply threads onto existing thread.
- watermark/updated_at bumping on every mutation (client delta sync depends on it).
- gmail api.ts MIME builder: headers, quoted-printable-free base64url, reply headers
  (In-Reply-To/References), unicode subject.
- history apply logic with synthetic history payloads.

## Whisk AI layer (convex/ai/, memories, reminders)

Classification is layered cheapest-first inside `applySyncedMessages`: learned
sender rules (memories kind "rule", keyed on the thread's STARTER), then
`lib/categorize.ts` heuristics (sender/subject patterns + Gmail CATEGORY_*
labels), then one scheduled `ai/actions.classifyThreads` batch (Haiku, ~25
threads per call) for the remainder. Verdicts write `threads.category` +
`category_source` ("user" > "rule" > "ai"/"heuristic"; a user verdict is never
overwritten) and ride the existing thread delta channel — no new subscription.

All model calls live in `ai/actions.ts` ("use node", Anthropic SDK; models in
`ai/llm.ts`: Haiku for classify/summaries, Opus for drafts/rewrites/voice).
Every AI schedule point is guarded on ANTHROPIC_API_KEY so unconfigured
deployments (and tests) schedule nothing.

Memories are the whole personalization store: one table, plain text rows the
client renders and deletes (kinds style/contact/rule/preference). The voice
profile (`ai/actions.buildStyleProfile`) distills sent mail into style rows
after backfill; corrections upsert rule rows and sweep the sender's other
threads (`dispatch.setCategory`); drafts read style + thread-participant
contact rows + preferences and nothing else.

Reminders: kind "snooze" (archive now via the normal outbound modify, restore
INBOX at remind_at) and "followup" (fire only if thread.last_at is still at
its baseline — a reply resolves silently). A one-minute cron
(`reminders.fireDue`) walks the armed-by-time index; fired threads return
INBOX+UNREAD. Side effects setReminder/cancelReminder in dispatch; one armed
reminder per thread.

`thread_ai` caches one summary per thread keyed by message_count, so a
summary is paid for once per thread state.

## Topics and LLM filters

`clusters` holds account-owned names/descriptions at two levels: streams,
and themes (`kind: "theme"`) that streams sit in through `parent_id`;
`threads.cluster_id` and `cluster_source` carry membership on the existing
thread sync channel, and a thread can sit in a theme directly. One scheduled
job per account runs bounded discovery using the existing Anthropic client.
Candidate batches put repeated senders together before semantic judgment,
then revisit unmatched threads against the roster of streams (themes are
never batch targets). A proposed stream needs a minimum number of threads in
its batch (four, three or two by granularity), told to the model and
enforced by the parser. When the batches are done the run hands off to a
theme action of its own (`startThemes` → `themeInbox`): one call reads every
stream side by side (name, description, size, sender domains, lanes,
samples), the themes that exist, and loose automated mail rolled up per
sender (people left out), and returns the themes, which stream sits in
which, merges between streams (optionally naming the result) and which loose
senders join a theme. Ids in that call are short indexes so the answer stays
small. The person's streams and themes (`isMine`: made, named, merged,
filed or muted by hand) are never folded, renamed or moved; a stream they
filed stays filed. A bad verdict is dropped whole and said on the account.
The theme call runs when a run made a stream, on a fresh regroup and on
the six hour revisit pass, and on a mailbox with topics but no themes yet.
Jobs chain after three model calls; a dirty bit preserves mail arriving
mid-run, and `accounts.cluster_progress` carries threads read of total for
the client (`tidy` marks the theme pass). Each call has a bounded timeout.
It preserves current assignments until a complete, validated verdict lands.
The write side rechecks the run stamp, enabled preference and manual
placements. A failed call records an account error and preserves existing
topics.

A run reads at most three batches per action (150 s each, no retry) so it
stays inside the ten-minute action cap; the theme call gets its own action
and 420 s; a batch the model does not answer goes to the second look, and a
cron sweeps runs older than thirty minutes so a killed action never leaves a
mailbox claiming to be busy. A model stream dissolves when no inbox thread
remains in it, then a model theme with no live stream and no inbox thread of
its own. `clusters.hidden` and `clusters.archive_new_since` together are a
muted topic (the `setClusterTreatment` side effect, which makes it the
person's); placing a thread whose Convex creation time is after
`archive_new_since` into such a topic, or into a stream of such a theme,
removes INBOX through the same label path a hand gesture uses and queues the
modify. Gmail batch calls page at 1000 ids. On-demand model calls (parse,
preview, run, regroup) draw on `accounts.ai_window_spent`, 120 per hour per
mailbox; scheduled work does not.

`filters` stores the owner-reviewed condition and constrained actions. The
parser is told what the judge can see and turns down conditions that need a
thread's age, read state or the person's contacts. The judge reads prefixed
ids (`t0`, `f0`), the owner's address, and only the fields the prompt names;
hits land per batch. New
inbound messages schedule judging independently of lane classification. Reads are
batched; applying hits rechecks account ownership, filter revision, enabled state
and the thread's message count/time. `filter_matches` deduplicates retries of the
same filter revision and conversation version. Filters never override manual
lane/topic placement. Automatic runs skip inbound messages predating the filter;
only an explicitly requested existing-inbox run includes old mail. Retried saves
are idempotent, and editing a paused filter leaves it paused. All three tables are included in account cleanup.

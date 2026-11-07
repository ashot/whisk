import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

// A mail address as it appears in a header. `name` is absent when the header
// carried a bare address.
export const addressValidator = v.object({
  name: v.optional(v.string()),
  email: v.string(),
});

// Attachment metadata only. Bytes stay in Gmail and are fetched on demand
// through the attachment id.
export const attachmentValidator = v.object({
  filename: v.string(),
  mime_type: v.string(),
  size: v.number(),
  gmail_attachment_id: v.string(),
});

// A file on a message that has not left yet. Its bytes are either a storage
// upload the sender made, or an attachment of a message already in the
// mailbox (a forward), which the pump fetches from Gmail at send time.
export const outgoingAttachmentValidator = v.object({
  filename: v.string(),
  mime_type: v.string(),
  size: v.number(),
  storage_id: v.optional(v.id("_storage")),
  message_gmail_id: v.optional(v.string()),
  gmail_attachment_id: v.optional(v.string()),
});

export const providerValidator = v.union(
  v.literal("gmail"),
  v.literal("demo"),
);

export const syncStatusValidator = v.union(
  v.literal("idle"),
  v.literal("backfilling"),
  v.literal("syncing"),
  v.literal("error"),
);

export default defineSchema({
  // Convex Auth's own tables (authSessions, authAccounts, authRefreshTokens,
  // authVerificationCodes, authVerifiers, authRateLimits). `users` is
  // overridden just below: whisk's roster fields merged into the shape the
  // library expects.
  ...authTables,

  // The identity everything hangs off: one human, owning a set of connected
  // accounts. Signing in with ANY of their addresses recovers the whole set.
  // Also Convex Auth's users table: a Google sign-in lands here through
  // makeCreateOrUpdateUser, deduped on the `email` index.
  users: defineTable({
    // Convex Auth profile fields. `email` drives the sign-in dedup; the
    // migration stamps it from primary_email on legacy rows.
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // The first address this user connected with — display/debug only; auth
    // always resolves through accounts.user_id. Optional because Convex Auth
    // creates rows without it.
    primary_email: v.optional(v.string()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  accounts: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    picture: v.optional(v.string()),
    provider: providerValidator,
    // Gmail's history cursor. Absent until the first backfill finishes.
    history_id: v.optional(v.string()),
    sync_status: syncStatusValidator,
    sync_error: v.optional(v.string()),
    last_synced_at: v.optional(v.number()),
    // What Google granted at the last consent (space-separated in the token
    // response, one entry each here). Absent on rows connected before scopes
    // were recorded, which reads as "mail only": the calendar asks those
    // accounts to reconnect once.
    scopes: v.optional(v.array(v.string())),
    // The verified addresses Gmail lets this mailbox send as ("send mail
    // as"), and when they were last read. Absent until the first read:
    // the mailbox then sends as its own address.
    send_as: v.optional(
      v.array(v.object({ email: v.string(), name: v.optional(v.string()), is_default: v.optional(v.boolean()) })),
    ),
    send_as_at: v.optional(v.number()),
    // The calendar mirror keeps its own clock so a calendar failure never
    // wedges mail sync, and vice versa.
    calendar_synced_at: v.optional(v.number()),
    calendar_error: v.optional(v.string()),
    calendar_write_error: v.optional(v.string()),
    calendar_sync_run: v.optional(v.string()),
    calendar_sync_started_at: v.optional(v.number()),
    calendar_demo_seeded: v.optional(v.boolean()),
    // Owner. Optional only for rows that predate the users table; the
    // backfill migration stamps every row.
    user_id: v.optional(v.id("users")),
    // The pending clustering pass, if one is scheduled: every sync that lands
    // new inbox mail replaces it, so a burst of syncs costs one model call.
    cluster_job: v.optional(v.id("_scheduled_functions")),
    cluster_started_at: v.optional(v.number()),
    cluster_dirty: v.optional(v.boolean()),
    cluster_error: v.optional(v.string()),
    // How far the running pass has read: threads judged so far out of the
    // threads it set out to read, and whether it is on its second look at
    // the mail the first look left without a topic.
    cluster_progress: v.optional(
      v.object({ done: v.number(), total: v.number(), review: v.boolean(), tidy: v.optional(v.boolean()) }),
    ),
    // When an incremental pass last re-offered recent unclustered mail, so
    // that second chance costs one model read every few hours, not one per
    // arriving thread.
    cluster_revisited_at: v.optional(v.number()),
    // On-demand model calls this hour (filters read, previewed or run by
    // hand, regroups), so a runaway client cannot burn the key.
    ai_window_start: v.optional(v.number()),
    ai_window_spent: v.optional(v.number()),
    updated_at: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_user", ["user_id"]),

  // A random token, sha256-hashed at rest — one device's login. It maps to a
  // USER; the user's accounts are resolved through accounts.user_id, so every
  // device sees the same roster. account_id remains only on rows that predate
  // the users table (the resolver falls back, the migration stamps them).
  auth_sessions: defineTable({
    user_id: v.optional(v.id("users")),
    account_id: v.optional(v.id("accounts")),
    token_hash: v.string(),
    created_at: v.number(),
    last_seen_at: v.number(),
    // Single-use attach ticket: minted by gmail.oauth.mintAttachTicket for a
    // Convex Auth caller, consumed the moment its connect lands.
    ticket: v.optional(v.boolean()),
    // Human label for a login minted for a terminal (devices.mint): the
    // machine name, so the owner can tell the rows apart when revoking.
    device_name: v.optional(v.string()),
    // An app token (connect.ts): the connected app's id and the scopes the
    // person granted it. lib/auth resolves such a row only for a function
    // that names one of these scopes. Absent on terminal and browser logins.
    app_id: v.optional(v.string()),
    scopes: v.optional(v.array(v.string())),
    // A terminal login for agents: it never sees private mail, reaches only
    // functions that name a scope it holds (`scopes`, else every app scope),
    // and so cannot change prefs, privacy rules or other logins. App logins
    // hide private mail the same way without this flag.
    hides_private: v.optional(v.boolean()),
  })
    .index("by_token_hash", ["token_hash"])
    .index("by_account", ["account_id"])
    .index("by_user", ["user_id"]),

  // One-time codes from the connect screen (connect.approve), traded once by
  // the app's server for an app token (POST /apps/token). Only the code's
  // sha256 is stored. A redeemed row stays until it expires so a second
  // redemption is caught and revokes the token the first one minted.
  app_codes: defineTable({
    code_hash: v.string(),
    user_id: v.id("users"),
    app_id: v.string(),
    scopes: v.array(v.string()),
    created_at: v.number(),
    expires_at: v.number(),
    redeemed_at: v.optional(v.number()),
    session_id: v.optional(v.id("auth_sessions")),
    // sha256 of the state the app sent with the connect link. The exchange
    // must present the same state, so a code that leaks cannot be redeemed
    // under another person's state at the app.
    state_hash: v.optional(v.string()),
  })
    .index("by_code_hash", ["code_hash"])
    .index("by_expires", ["expires_at"]),

  // OAuth material. No query ever returns a row from this table. Both tokens
  // are sealed with AES-GCM under WHISK_CREDENTIALS_KEY (lib/credentials.ts);
  // a value without the seal prefix is a row the migration has not reached.
  credentials: defineTable({
    account_id: v.id("accounts"),
    access_token: v.string(),
    refresh_token: v.string(),
    // Epoch millis at which access_token stops working.
    expiry: v.number(),
  }).index("by_account", ["account_id"]),

  labels: defineTable({
    account_id: v.id("accounts"),
    gmail_id: v.string(),
    name: v.string(),
    kind: v.union(v.literal("system"), v.literal("user")),
    color: v.optional(v.string()),
    updated_at: v.number(),
    deleted: v.optional(v.boolean()),
  })
    .index("by_account", ["account_id", "updated_at"])
    .index("by_account_gmail", ["account_id", "gmail_id"]),

  threads: defineTable({
    account_id: v.id("accounts"),
    gmail_id: v.string(),
    subject: v.string(),
    snippet: v.string(),
    participants: v.array(addressValidator),
    message_count: v.number(),
    last_at: v.number(),
    // Gmail label id strings ("INBOX", "Label_7"), the union over the thread's
    // messages.
    label_ids: v.array(v.string()),
    is_unread: v.boolean(),
    is_starred: v.boolean(),
    has_attachments: v.boolean(),
    // Set on threads born from a local send so the client's optimistic stub
    // can be superseded by the synced row.
    client_id: v.optional(v.string()),
    // Lane the thread files under (a CategoryId from @mail/shared). Absent =
    // primary. Rides the existing thread delta channel, so the client learns
    // it with no extra subscription.
    category: v.optional(v.string()),
    // Who decided: "user" (a correction — never overwritten), "rule" (a
    // learned sender rule), "ai", or "heuristic". Absent = unclassified.
    category_source: v.optional(
      v.union(
        v.literal("user"),
        v.literal("rule"),
        v.literal("ai"),
        v.literal("heuristic"),
      ),
    ),
    // Topic cluster the thread belongs to (a row in `clusters`). Absent =
    // not clustered yet, or a singleton nothing else resembles. Rides the
    // thread delta channel like `category`.
    cluster_id: v.optional(v.id("clusters")),
    // "user": placed by hand (never moved by a regroup); "ai": the model.
    cluster_source: v.optional(v.union(v.literal("user"), v.literal("ai"))),
    // Lenses (@mail/shared/src/lib/lenses): per lens id, the model's 0-100
    // score for how clearly the thread belongs, its few words on why, and
    // the person's hand placement (final, and an example for the model).
    lens_scores: v.optional(v.record(v.string(), v.number())),
    lens_why: v.optional(v.record(v.string(), v.string())),
    lens_marks: v.optional(v.record(v.string(), v.boolean())),
    // When the person last placed it by hand: the judge reads the newest.
    marked_at: v.optional(v.number()),
    // Private mail (@mail/shared/src/lib/privacy): the person's hand mark
    // (final), and the model's reading against their privacy rules: which
    // rules it falls under, which rule wordings it was read against, at what
    // message count, and why. Agents never see a thread that is private or
    // not yet read (lib/privacy).
    private_mark: v.optional(v.boolean()),
    private_hits: v.optional(v.array(v.string())),
    private_checked: v.optional(v.array(v.string())),
    private_count: v.optional(v.number()),
    private_why: v.optional(v.string()),
    // The single-lens fields lenses replaced; migrations:lensesFromImportance
    // moves them into the maps above. Remove once it has run everywhere.
    important: v.optional(v.boolean()),
    important_by: v.optional(v.union(v.literal("user"), v.literal("ai"))),
    important_why: v.optional(v.string()),
    updated_at: v.number(),
    deleted: v.optional(v.boolean()),
  })
    .index("by_account_last", ["account_id", "last_at"])
    .index("by_account_marked", ["account_id", "marked_at"])
    .index("by_account_updated", ["account_id", "updated_at"])
    .index("by_account_gmail", ["account_id", "gmail_id"])
    .index("by_account_client", ["account_id", "client_id"])
    .index("by_account_cluster", ["account_id", "cluster_id"]),

  messages: defineTable({
    account_id: v.id("accounts"),
    thread_gmail_id: v.string(),
    gmail_id: v.string(),
    from: addressValidator,
    to: v.array(addressValidator),
    cc: v.array(addressValidator),
    bcc: v.array(addressValidator),
    reply_to: v.optional(addressValidator),
    date: v.number(),
    snippet: v.string(),
    body_html: v.optional(v.string()),
    body_text: v.optional(v.string()),
    label_ids: v.array(v.string()),
    is_unread: v.boolean(),
    attachments: v.array(attachmentValidator),
    // RFC 5322 Message-ID and the reply chain, needed to build correct reply
    // headers without another Gmail round trip.
    header_message_id: v.optional(v.string()),
    in_reply_to: v.optional(v.string()),
    references: v.optional(v.string()),
    client_id: v.optional(v.string()),
    updated_at: v.number(),
    deleted: v.optional(v.boolean()),
  })
    .index("by_account_thread", ["account_id", "thread_gmail_id", "date"])
    .index("by_account_gmail", ["account_id", "gmail_id"])
    .index("by_account_updated", ["account_id", "updated_at"])
    .index("by_account_client", ["account_id", "client_id"])
    // Sent-stub adoption during sync looks a message up by its RFC 5322
    // Message-ID. Without this index that lookup collected the whole thread —
    // bodies included — once per synced message, which is what pushed big
    // apply batches over the mutation read limit.
    .index("by_account_header", ["account_id", "header_message_id"]),

  // The outbound op queue. Every write that must reach Gmail lands here first
  // and the pump action drains it in creation order.
  outbound: defineTable({
    account_id: v.id("accounts"),
    kind: v.union(v.literal("modify"), v.literal("send"), v.literal("calendar")),
    payload: v.any(),
    status: v.union(
      v.literal("queued"),
      v.literal("inflight"),
      v.literal("done"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    attempts: v.number(),
    retry_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_account_status", ["account_id", "status", "created_at"])
    .index("by_account_kind_status", ["account_id", "kind", "status", "created_at"]),

  drafts: defineTable({
    account_id: v.id("accounts"),
    // Client-generated and stable across the draft's life.
    client_id: v.string(),
    // The Gmail draft message it came from, for a draft saved to Gmail
    // elsewhere; sending or discarding it here deletes that draft in Gmail.
    gmail_message_id: v.optional(v.string()),
    thread_gmail_id: v.optional(v.string()),
    to: v.array(addressValidator),
    cc: v.array(addressValidator),
    bcc: v.array(addressValidator),
    // The address it sends as; absent = the account's default.
    from: v.optional(v.string()),
    subject: v.string(),
    body_text: v.string(),
    reply_to_gmail_id: v.optional(v.string()),
    mode: v.union(
      v.literal("new"),
      v.literal("reply"),
      v.literal("replyAll"),
      v.literal("forward"),
    ),
    attachments: v.optional(v.array(outgoingAttachmentValidator)),
    updated_at: v.number(),
    deleted: v.optional(v.boolean()),
  })
    .index("by_account", ["account_id", "updated_at"])
    .index("by_account_client", ["account_id", "client_id"]),

  // What Whisk has learned: voice, contacts, filing rules, preferences. Small
  // rows of plain text the user can read and delete — every AI surface
  // (classifier, drafts, summaries) reads from here and nowhere else.
  memories: defineTable({
    account_id: v.id("accounts"),
    kind: v.union(
      v.literal("style"), // how the owner writes (tone, greeting, sign-off)
      v.literal("contact"), // a fact about one correspondent
      v.literal("rule"), // sender → category filing rule
      v.literal("preference"), // anything else the owner told Whisk
    ),
    text: v.string(),
    // For contact/rule memories: the address the memory is about.
    contact_email: v.optional(v.string()),
    // For rule memories: the lane threads from this sender file under.
    category: v.optional(v.string()),
    source: v.union(
      v.literal("correction"),
      v.literal("sent"),
      v.literal("manual"),
    ),
    created_at: v.number(),
    updated_at: v.number(),
    deleted: v.optional(v.boolean()),
  })
    .index("by_account", ["account_id", "updated_at"])
    .index("by_account_contact", ["account_id", "contact_email"]),

  // Snoozes and follow-up watches. A snooze leaves the inbox now and returns
  // at remind_at; a followup fires only if the thread is still waiting for a
  // reply then. One armed reminder per thread.
  reminders: defineTable({
    account_id: v.id("accounts"),
    thread_gmail_id: v.string(),
    kind: v.union(v.literal("snooze"), v.literal("followup")),
    remind_at: v.number(),
    // thread.last_at when armed — a later message means someone replied.
    baseline_last_at: v.number(),
    status: v.union(
      v.literal("armed"),
      v.literal("fired"), // came due; surfaced back to the inbox
      v.literal("resolved"), // followup satisfied by a reply before remind_at
      v.literal("canceled"),
    ),
    created_at: v.number(),
    updated_at: v.number(),
    deleted: v.optional(v.boolean()),
  })
    .index("by_account", ["account_id", "updated_at"])
    .index("by_account_thread", ["account_id", "thread_gmail_id"])
    .index("by_status_time", ["status", "remind_at"]),

  // Topics, at two levels. A stream is what the model gathers from a batch
  // of mail, mostly one sender's ("Temu order updates", "Care.com
  // applicants"). A theme (kind "theme") is what several streams have in
  // common in the person's life ("Childcare search", "Money"); streams
  // carry `parent_id`, and straggler mail can sit in a theme directly. The
  // name and description are what the model reads to place new mail, so a
  // rename is also a teaching gesture. Membership lives on threads.cluster_id.
  clusters: defineTable({
    account_id: v.id("accounts"),
    name: v.string(),
    description: v.string(),
    // Hue (deg) for the chip/card; picked by the server on creation.
    hue: v.number(),
    kind: v.optional(v.literal("theme")),
    parent_id: v.optional(v.id("clusters")),
    // "user": created, renamed, merged, moved or muted by hand — the
    // person's; a regroup keeps it as is. "ai": the model's; a fresh
    // regroup may dissolve, rename or refile it.
    source: v.union(v.literal("user"), v.literal("ai")),
    // Older rows marked the person's topics this way; read through
    // `isMine`, never written by new code.
    pinned: v.optional(v.boolean()),
    // Hidden: out of the inbox list and its unread count, quiet in
    // notifications. With `archive_new_since` set too, the topic is muted.
    hidden: v.optional(v.boolean()),
    // Archive mail that joins this topic (or a stream in it) after
    // `archive_new_since`; older mail already in the inbox is left alone.
    archive_new_since: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
    deleted: v.optional(v.boolean()),
  }).index("by_account", ["account_id", "updated_at"]),

  // Natural-language filters. `text` is what the owner typed; the model
  // parsed it once into a `condition` (what to match, in plain words) and a
  // fixed list of `actions`. New inbound threads are judged against every
  // enabled condition in one batched model call; matches run the actions
  // through the same machinery as a hand gesture.
  filters: defineTable({
    account_id: v.id("accounts"),
    text: v.string(),
    condition: v.string(),
    actions: v.array(
      v.object({
        kind: v.union(
          v.literal("archive"),
          v.literal("trash"),
          v.literal("star"),
          v.literal("read"),
          v.literal("label"), // arg: label name
          v.literal("lane"), // arg: category id or "primary"
          v.literal("cluster"), // arg: cluster name (created on first hit)
        ),
        arg: v.optional(v.string()),
      }),
    ),
    enabled: v.boolean(),
    revision: v.optional(v.number()),
    hits: v.number(),
    last_error: v.optional(v.string()),
    last_checked_at: v.optional(v.number()),
    // The last few threads the filter acted on, newest first, so the owner
    // can see what it has been doing.
    recent: v.array(
      v.object({ thread_gmail_id: v.string(), subject: v.string(), at: v.number() }),
    ),
    // Saved by a login that cannot see private mail: it never acts on a
    // thread such a login could not see.
    hides_private: v.optional(v.boolean()),
    created_at: v.number(),
    updated_at: v.number(),
    deleted: v.optional(v.boolean()),
  }).index("by_account", ["account_id", "updated_at"]),

  filter_matches: defineTable({
    account_id: v.id("accounts"),
    filter_id: v.id("filters"),
    thread_gmail_id: v.string(),
    revision: v.number(),
    message_count: v.number(),
    last_at: v.number(),
    updated_at: v.number(),
  }).index("by_filter_thread", ["filter_id", "thread_gmail_id"]),

  // Cached AI reading of one thread, keyed by how many messages it covered —
  // reopening a summarized thread costs nothing until new mail arrives.
  thread_ai: defineTable({
    account_id: v.id("accounts"),
    thread_gmail_id: v.string(),
    /** The whole conversation, for the thread view. */
    summary: v.optional(v.string()),
    message_count: v.optional(v.number()),
    /** Only the newest message, for the new-mail notification. */
    latest_summary: v.optional(v.string()),
    latest_message_count: v.optional(v.number()),
    updated_at: v.number(),
  }).index("by_account_thread", ["account_id", "thread_gmail_id"]),

  // ——— Calendar ———
  //
  // Google Calendar mirrored the way Gmail is: calendars are the "labels" of
  // the calendar world (one row per calendar on the account's list), events
  // are the rows the timeline renders. Both ride the same updated_at delta
  // channel and tombstone contract as threads, so the client's sync engine
  // treats them exactly like mail.

  calendars: defineTable({
    account_id: v.id("accounts"),
    // Google's calendar id ("primary" resolves to the address; we store the
    // address form the list returns so ids stay stable across calls).
    google_id: v.string(),
    summary: v.string(),
    description: v.optional(v.string()),
    // Hex colors from the calendar list. Kept as Google gives them: people
    // recognise their own calendar colors, and the UI tints them into the
    // palette rather than replacing them.
    color: v.optional(v.string()),
    foreground: v.optional(v.string()),
    primary: v.optional(v.boolean()),
    // Google's own "shown in the UI" flag; hidden calendars are not synced.
    selected: v.optional(v.boolean()),
    // "owner" | "writer" | "reader" | "freeBusyReader" — decides whether
    // the composer may create here.
    access_role: v.string(),
    time_zone: v.optional(v.string()),
    // Incremental cursor from events.list; absent until the first full pass.
    sync_token: v.optional(v.string()),
    full_synced_at: v.optional(v.number()),
    window_start: v.optional(v.number()),
    window_end: v.optional(v.number()),
    updated_at: v.number(),
    deleted: v.optional(v.boolean()),
  })
    .index("by_account", ["account_id", "updated_at"])
    .index("by_account_google", ["account_id", "google_id"]),

  events: defineTable({
    account_id: v.id("accounts"),
    calendar_google_id: v.string(),
    google_id: v.string(),
    ical_uid: v.optional(v.string()),
    summary: v.string(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    // Epoch millis. For an all-day event these are UTC midnights of the
    // start date and the (exclusive) end date, so a client reads the calendar
    // date back with the UTC getters and never shifts it by a time zone.
    start: v.number(),
    end: v.number(),
    all_day: v.boolean(),
    status: v.union(
      v.literal("confirmed"),
      v.literal("tentative"),
      v.literal("cancelled"),
    ),
    html_link: v.optional(v.string()),
    // The one link that joins the meeting: Google Meet from conferenceData,
    // else a video link found in location/description.
    conference_url: v.optional(v.string()),
    native_conference_url: v.optional(v.string()),
    create_fingerprint: v.optional(v.string()),
    reconcile_after: v.optional(v.number()),
    attendees: v.array(
      v.object({
        email: v.string(),
        name: v.optional(v.string()),
        response_status: v.optional(v.string()),
        self: v.optional(v.boolean()),
        organizer: v.optional(v.boolean()),
        optional: v.optional(v.boolean()),
      }),
    ),
    organizer: v.optional(
      v.object({
        email: v.string(),
        name: v.optional(v.string()),
        self: v.optional(v.boolean()),
      }),
    ),
    // The owner's own answer, lifted off the attendee list for cheap reads.
    // Absent = not invited (own event, or a calendar you only read).
    my_response: v.optional(
      v.union(
        v.literal("accepted"),
        v.literal("declined"),
        v.literal("tentative"),
        v.literal("needsAction"),
      ),
    ),
    recurring_event_id: v.optional(v.string()),
    recurring: v.optional(v.boolean()),
    sync_generation: v.optional(v.string()),
    local_written_at: v.optional(v.number()),
    pending_outbound: v.optional(v.id("outbound")),
    write_error: v.optional(v.string()),
    // Set on rows born from a local create so the client's optimistic stub
    // is superseded by the synced row.
    client_id: v.optional(v.string()),
    updated_at: v.number(),
    deleted: v.optional(v.boolean()),
  })
    .index("by_account_start", ["account_id", "start"])
    .index("by_account_updated", ["account_id", "updated_at"])
    .index("by_account_google", ["account_id", "calendar_google_id", "google_id"])
    .index("by_account_client", ["account_id", "client_id"]),

  // Per-USER UI preferences (one row per user, patched through dispatch), so
  // theme/density follow the person across devices. account_id remains only on
  // pre-migration rows. Named fields cover what the app reads today; `prefs`
  // is the open bag so a new client preference never needs a schema migration.
  // A phone that can be pushed to: one row per Expo push token, owned by the
  // user (not the mailbox), so one phone hears about every account the person
  // connected. Registered on every app launch; a dead token (app removed,
  // token rotated) is deleted when Expo says so.
  push_devices: defineTable({
    user_id: v.id("users"),
    push_token: v.string(),
    platform: v.union(v.literal("ios"), v.literal("android")),
    // The phone's IANA zone, so quiet hours run on the person's clock.
    time_zone: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user", ["user_id"])
    .index("by_token", ["push_token"]),

  client_state: defineTable({
    user_id: v.optional(v.id("users")),
    account_id: v.optional(v.id("accounts")),
    theme: v.optional(
      v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
    ),
    rail_collapsed: v.optional(v.boolean()),
    density: v.optional(v.union(v.literal("compact"), v.literal("cozy"))),
    // Senders whose remote images the reader may load.
    image_allowed_senders: v.optional(v.array(v.string())),
    signature: v.optional(v.string()),
    onboarding_dismissed: v.optional(v.boolean()),
    // Who may interrupt this person, and how (see shared/lib/notifications).
    // v.any(): the client owns the shape and evolves it without a migration.
    notifications: v.optional(v.any()),
    // Calendar display choices (hidden calendars). v.any() for the same
    // reason as notifications: the client owns the shape.
    calendar: v.optional(v.any()),
    last_view: v.optional(v.string()),
    prefs: v.optional(v.any()),
    updated_at: v.number(),
  })
    .index("by_account", ["account_id"])
    .index("by_user", ["user_id"]),
});

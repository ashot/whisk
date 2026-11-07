// Mail domain rows, mirroring packages/convex schema (client-safe fields only).

import type { CategoryId } from "../lib/categories";
import type { SendAs } from "../lib/sendAs";

export type Address = { name?: string; email: string };

export type Account = {
  _id: string;
  _creationTime?: number;
  email: string;
  name?: string;
  picture?: string;
  provider: "gmail" | "demo";
  sync_status: "idle" | "backfilling" | "syncing" | "error";
  sync_error?: string;
  /** The verified addresses Gmail lets this mailbox send as. */
  send_as?: SendAs[];
  calendar_enabled?: boolean;
  calendar_synced_at?: number;
  calendar_error?: string;
  last_synced_at?: number;
  /** A topic clustering pass is booked or running. */
  clustering?: boolean;
  cluster_error?: string;
  /** How far the running pass has read; `review` is its second look at
   *  the mail the first look left without a topic. */
  cluster_progress?: { done: number; total: number; review: boolean; tidy?: boolean };
  updated_at: number;
};

/** The scope every list, count and gesture reads through: one account's rows
 *  or the union of all of them. */
export type AccountScope = "all" | string;

export type Label = {
  _id: string;
  account_id: string;
  gmail_id: string;
  name: string;
  kind: "system" | "user";
  color?: { bg: string; fg: string };
  updated_at: number;
  deleted?: boolean;
};

export type Thread = {
  _id: string;
  account_id: string;
  gmail_id: string;
  /** Present on optimistic-send stubs and their server rows — the altKey that
   *  supersedes the stub once the server thread syncs back. */
  client_id?: string;
  subject: string;
  snippet: string;
  participants: Address[];
  message_count: number;
  last_at: number;
  label_ids: string[];
  is_unread: boolean;
  is_starred: boolean;
  has_attachments: boolean;
  /** Lane the thread files under; absent = primary (real correspondence). */
  category?: CategoryId;
  /** Who filed it: user correction > learned rule > model > heuristic. */
  category_source?: "user" | "rule" | "ai" | "heuristic";
  /** Topic the thread belongs to (a Cluster _id); absent = none. */
  cluster_id?: string;
  /** "user" placements are final for the model. */
  cluster_source?: "user" | "ai";
  /** The importance verdict: false files it under Other; absent = not
   *  judged yet, which shows in the inbox. */
  important?: boolean;
  /** "user" marks are final, and examples the model learns from. */
  important_by?: "user" | "ai";
  /** The model's few words on why. */
  important_why?: string;
  updated_at: number;
  deleted?: boolean;
};

/** A topic the model found in the inbox (or the person made): a stream of
 *  one sender's mail, or a theme that gathers streams around one concern. */
export type Cluster = {
  _id: string;
  account_id: string;
  name: string;
  description: string;
  hue: number;
  /** A theme holds streams (by their parent_id) and straggler mail. */
  kind?: "theme";
  /** The theme a stream sits in. */
  parent_id?: string;
  source: "user" | "ai";
  /** Older rows' mark for "the person's"; `isMine` reads it. */
  pinned?: boolean;
  /** Out of the inbox list, its unread count and notifications. */
  hidden?: boolean;
  /** Mail Whisk first saw after this stamp is archived as it joins. Set
   *  together with `hidden`, this is a muted topic. */
  archive_new_since?: number;
  created_at: number;
  updated_at: number;
  deleted?: boolean;
};

export type FilterActionKind =
  | "archive"
  | "trash"
  | "star"
  | "read"
  | "label"
  | "lane"
  | "cluster";

export type FilterAction = { kind: FilterActionKind; arg?: string };

/** A natural-language filter: the sentence, its parsed condition, and the
 *  actions a hit runs. */
export type Filter = {
  _id: string;
  account_id: string;
  text: string;
  condition: string;
  actions: FilterAction[];
  enabled: boolean;
  hits: number;
  last_error?: string;
  last_checked_at?: number;
  recent: Array<{ thread_gmail_id: string; subject: string; at: number }>;
  created_at: number;
  updated_at: number;
  deleted?: boolean;
};

export type Memory = {
  _id: string;
  account_id: string;
  kind: "style" | "contact" | "rule" | "preference";
  text: string;
  contact_email?: string;
  category?: string;
  source: "correction" | "sent" | "manual";
  created_at: number;
  updated_at: number;
  deleted?: boolean;
};

export type Reminder = {
  _id: string;
  account_id: string;
  thread_gmail_id: string;
  kind: "snooze" | "followup";
  remind_at: number;
  baseline_last_at: number;
  status: "armed" | "fired" | "resolved" | "canceled";
  created_at: number;
  updated_at: number;
  deleted?: boolean;
};

export type Attachment = {
  filename: string;
  mime_type: string;
  size: number;
  gmail_attachment_id: string;
};

/** A file on a message not yet sent. Bytes live in one of two places: a
 *  storage upload (`storage_id`) or an attachment of a message already in the
 *  mailbox (`message_gmail_id` + `gmail_attachment_id`, the forward case). */
export type OutgoingAttachment = {
  filename: string;
  mime_type: string;
  size: number;
  storage_id?: string;
  message_gmail_id?: string;
  gmail_attachment_id?: string;
};

export type Message = {
  _id: string;
  account_id: string;
  thread_gmail_id: string;
  gmail_id: string;
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  reply_to?: Address;
  date: number;
  snippet: string;
  body_html?: string;
  body_text?: string;
  label_ids: string[];
  is_unread: boolean;
  attachments: Attachment[];
  header_message_id?: string;
  updated_at: number;
  deleted?: boolean;
};

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export type Draft = {
  client_id: string;
  /** Which account sends/owns this draft. Absent on legacy local drafts —
   *  treated as the primary account. */
  account_id?: string;
  /** The address it sends as (one of the account's send_as). Absent = the
   *  account's default. */
  from?: string;
  /** Set on a draft saved to Gmail elsewhere: the Gmail message it mirrors. */
  gmail_message_id?: string;
  thread_gmail_id?: string;
  reply_to_gmail_id?: string;
  mode: ComposeMode;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  body_text: string;
  attachments?: OutgoingAttachment[];
  updated_at: number;
};

// Well-known Gmail system label ids.
export const L = {
  INBOX: "INBOX",
  STARRED: "STARRED",
  UNREAD: "UNREAD",
  SENT: "SENT",
  DRAFT: "DRAFT",
  TRASH: "TRASH",
  SPAM: "SPAM",
} as const;

export type ViewId =
  | "inbox"
  | "other"
  | "starred"
  | "drafts"
  | "sent"
  | "archive"
  | "trash"
  | "spam"
  | "sweep"
  | "calendar"
  | "later"
  | "waiting"
  | `cat:${string}`
  | `cluster:${string}`
  | `label:${string}`
  | `search:${string}`;

export type ThreadOp = {
  thread_gmail_ids: string[];
  add_label_ids: string[];
  remove_label_ids: string[];
  /** Which account the threads live in; gestures in the unified view emit one
   *  op per account. Absent = the session's primary account. */
  account_id?: string;
};

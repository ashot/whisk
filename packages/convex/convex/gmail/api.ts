import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { normalizeLabels } from "../lib/threads";
import type { SendAs } from "@mail/shared/src/lib/sendAs";

// A thin, dependency-free Gmail REST client. Everything here is either a pure
// function (encoders, parsers, the MIME builder) so tests can drive it without
// a network, or a `fetch` call. No googleapis.

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_UPLOAD_API = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type Address = { name?: string; email: string };

export type ParsedMessage = {
  gmail_id: string;
  thread_gmail_id: string;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  reply_to?: Address;
  date: number;
  snippet: string;
  body_html?: string;
  body_text?: string;
  label_ids: string[];
  is_unread: boolean;
  attachments: Array<{
    filename: string;
    mime_type: string;
    size: number;
    gmail_attachment_id: string;
  }>;
  header_message_id?: string;
  in_reply_to?: string;
  references?: string;
  subject: string;
};

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return binary;
}

export function base64Encode(text: string): string {
  return base64EncodeBytes(new TextEncoder().encode(text));
}

export function base64EncodeBytes(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes));
}

export function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlEncode(text: string): string {
  return toBase64Url(base64Encode(text));
}

/** Gmail returns attachment payloads as base64url; decode to raw bytes. */
export function base64UrlToBytes(data: string): Uint8Array {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Gmail returns bodies as base64url; decode back to a UTF-8 string. */
export function base64UrlDecode(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const ASCII_ONLY = /^[\x20-\x7E]*$/;

/**
 * RFC 2047 encoded-word for header values that leave ASCII. Gmail's API returns
 * headers already decoded, so this only ever runs on the way out.
 */
export function encodeHeaderValue(value: string): string {
  if (ASCII_ONLY.test(value)) return value;
  return `=?UTF-8?B?${base64Encode(value)}?=`;
}

export function formatAddress(address: Address): string {
  if (!address.name) return address.email;
  const name = ASCII_ONLY.test(address.name)
    ? // A display name with specials must be a quoted-string.
      /[",;:<>@()\[\]\\]/.test(address.name)
      ? `"${address.name.replace(/(["\\])/g, "\\$1")}"`
      : address.name
    : encodeHeaderValue(address.name);
  return `${name} <${address.email}>`;
}

export function formatAddressList(addresses: readonly Address[]): string {
  return addresses.map(formatAddress).join(", ");
}

/** Split a header address list, respecting quoted display names. */
export function parseAddressList(header: string | undefined): Address[] {
  if (!header) return [];
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of header) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === "," && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  const out: Address[] = [];
  for (const raw of parts) {
    const address = parseAddress(raw);
    if (address) out.push(address);
  }
  return out;
}

export function parseAddress(raw: string): Address | null {
  const text = raw.trim();
  if (!text) return null;
  const angled = text.match(/^(.*)<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1].trim().replace(/^"|"$/g, "").replace(/\\"/g, '"');
    const email = angled[2].trim();
    if (!email) return null;
    return name ? { name, email } : { email };
  }
  return { email: text };
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

export type MimeAttachment = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type MimeInput = {
  from: Address;
  to: readonly Address[];
  cc?: readonly Address[];
  bcc?: readonly Address[];
  subject: string;
  bodyText: string;
  inReplyTo?: string;
  references?: string;
  date?: Date;
  messageId?: string;
  attachments?: readonly MimeAttachment[];
};

function wrap76(text: string): string {
  return (text.match(/.{1,76}/g) ?? []).join("\r\n");
}

const TEXT_PART = 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64';

/** A filename inside a header parameter: quotes and line breaks would end
 *  the parameter early; anything outside ASCII goes as an encoded word. */
function headerFilename(name: string): string {
  return encodeHeaderValue(name.replace(/["\\\r\n]/g, "_"));
}

/**
 * The message as RFC 5322 text. Text only is a single part; with files it
 * is multipart/mixed, the text first. Every body is base64 (never
 * quoted-printable) so no character needs escaping and line length is ours
 * to control.
 */
export function buildMimeMessage(input: MimeInput): string {
  const headers: string[] = [];
  headers.push(`From: ${formatAddress(input.from)}`);
  headers.push(`To: ${formatAddressList(input.to)}`);
  if (input.cc && input.cc.length > 0) {
    headers.push(`Cc: ${formatAddressList(input.cc)}`);
  }
  if (input.bcc && input.bcc.length > 0) {
    headers.push(`Bcc: ${formatAddressList(input.bcc)}`);
  }
  headers.push(`Subject: ${encodeHeaderValue(input.subject)}`);
  headers.push(`Date: ${(input.date ?? new Date()).toUTCString()}`);
  if (input.messageId) headers.push(`Message-ID: ${input.messageId}`);
  // Both headers are required for a reply to thread correctly in every client,
  // not just Gmail's own.
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) headers.push(`References: ${input.references}`);
  headers.push("MIME-Version: 1.0");
  const text = wrap76(base64Encode(input.bodyText));
  const files = input.attachments ?? [];
  if (files.length === 0) {
    return `${headers.join("\r\n")}\r\n${TEXT_PART}\r\n\r\n${text}`;
  }
  // Base64 bodies never contain "=_", so the boundary cannot occur inside a part.
  const boundary = `=_whisk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `${TEXT_PART}\r\n\r\n${text}`,
    ...files.map((f) => {
      const name = headerFilename(f.filename);
      const type = f.mimeType.split(";")[0].trim() || "application/octet-stream";
      return `Content-Type: ${type}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(base64EncodeBytes(f.bytes))}`;
    }),
  ];
  return `${headers.join("\r\n")}\r\n\r\n--${boundary}\r\n${parts.join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--`;
}

export function buildRawMessage(input: MimeInput): string {
  return base64UrlEncode(buildMimeMessage(input));
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
};

export function headerValue(
  part: GmailPart | undefined,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === wanted)?.value;
}

/**
 * Walk the MIME tree once, collecting the best text and html bodies plus every
 * attachment part. "Best" means the first of each type outside an attachment
 * disposition — nested multipart/alternative inside multipart/mixed included.
 */
export function walkParts(payload: GmailPart | undefined): {
  text?: string;
  html?: string;
  attachments: ParsedMessage["attachments"];
} {
  const attachments: ParsedMessage["attachments"] = [];
  let text: string | undefined;
  let html: string | undefined;

  const visit = (part: GmailPart | undefined) => {
    if (!part) return;
    const mimeType = part.mimeType ?? "";
    const isAttachment =
      !!part.body?.attachmentId &&
      (!!part.filename ||
        (headerValue(part, "Content-Disposition") ?? "").includes("attachment"));

    if (isAttachment) {
      attachments.push({
        filename: part.filename || "attachment",
        mime_type: mimeType || "application/octet-stream",
        size: part.body?.size ?? 0,
        gmail_attachment_id: part.body!.attachmentId!,
      });
    } else if (part.body?.data) {
      if (mimeType === "text/plain" && text === undefined) {
        text = base64UrlDecode(part.body.data);
      } else if (mimeType === "text/html" && html === undefined) {
        html = base64UrlDecode(part.body.data);
      }
    }
    for (const child of part.parts ?? []) visit(child);
  };

  visit(payload);
  return { text, html, attachments };
}

export type AttachmentPartRef = {
  attachment_id: string;
  mime_type: string;
  filename: string;
};

/**
 * Find one attachment part in a freshly fetched message. Lookup runs against
 * the live payload (attachment ids are not guaranteed stable across fetches,
 * so a stored id is a hint, not an address): match by stored id first, then by
 * Content-ID (for cid: inline images), then by filename.
 */
export function findAttachmentPart(
  payload: GmailPart | undefined,
  wanted: { attachmentId?: string; cid?: string; filename?: string },
): AttachmentPartRef | null {
  const normalizeCid = (value: string) => value.replace(/^<|>$/g, "").trim();
  let byId: AttachmentPartRef | null = null;
  let byCid: AttachmentPartRef | null = null;
  let byName: AttachmentPartRef | null = null;

  const visit = (part: GmailPart | undefined) => {
    if (!part) return;
    const attachmentId = part.body?.attachmentId;
    if (attachmentId) {
      const ref: AttachmentPartRef = {
        attachment_id: attachmentId,
        mime_type: part.mimeType || "application/octet-stream",
        filename: part.filename || "attachment",
      };
      if (wanted.attachmentId && attachmentId === wanted.attachmentId) {
        byId ??= ref;
      }
      const cidHeader = headerValue(part, "Content-ID");
      if (
        wanted.cid &&
        cidHeader &&
        normalizeCid(cidHeader) === normalizeCid(wanted.cid)
      ) {
        byCid ??= ref;
      }
      if (wanted.filename && part.filename === wanted.filename) {
        byName ??= ref;
      }
    }
    for (const child of part.parts ?? []) visit(child);
  };
  visit(payload);
  return byId ?? byCid ?? byName;
}

export function parseGmailMessage(message: GmailMessage): ParsedMessage {
  const payload = message.payload;
  const { text, html, attachments } = walkParts(payload);
  // Canonical order from the moment a label set enters the system.
  const labelIds = normalizeLabels(message.labelIds ?? []);
  const from = parseAddress(headerValue(payload, "From") ?? "") ?? {
    email: "unknown@unknown",
  };
  const replyTo = parseAddress(headerValue(payload, "Reply-To") ?? "");
  const dateHeader = headerValue(payload, "Date");
  const internal = message.internalDate ? Number(message.internalDate) : NaN;
  const date = Number.isFinite(internal)
    ? internal
    : dateHeader
      ? Date.parse(dateHeader) || Date.now()
      : Date.now();

  return {
    gmail_id: message.id,
    thread_gmail_id: message.threadId,
    from,
    to: parseAddressList(headerValue(payload, "To")),
    cc: parseAddressList(headerValue(payload, "Cc")),
    bcc: parseAddressList(headerValue(payload, "Bcc")),
    reply_to: replyTo ?? undefined,
    date,
    snippet: decodeEntities(message.snippet ?? ""),
    body_html: html,
    body_text: text,
    label_ids: labelIds,
    is_unread: labelIds.includes("UNREAD"),
    attachments,
    header_message_id: headerValue(payload, "Message-ID"),
    in_reply_to: headerValue(payload, "In-Reply-To"),
    references: headerValue(payload, "References"),
    subject: headerValue(payload, "Subject") ?? "",
  };
}

/** Gmail snippets arrive HTML-escaped; the client renders them as plain text. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

type ActionCtx = {
  runQuery: (fn: any, args: any) => Promise<any>;
  runMutation: (fn: any, args: any) => Promise<any>;
};

// One refresh in flight per account. Actions run in isolates, so this collapses
// the bursts that matter: a pump and a sync waking on the same account.
const refreshInFlight = new Map<string, Promise<string>>();

const EXPIRY_SKEW_MS = 60_000;

export function oauthConfig() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUrl = process.env.OAUTH_REDIRECT_URL;
  return { clientId, clientSecret, redirectUrl };
}

export function requireOauthConfig() {
  const config = oauthConfig();
  if (!config.clientId || !config.clientSecret || !config.redirectUrl) {
    throw new Error(
      "Gmail OAuth is not configured: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and OAUTH_REDIRECT_URL",
    );
  }
  return config as { clientId: string; clientSecret: string; redirectUrl: string };
}

export async function getAccessToken(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
): Promise<string> {
  const credentials = await ctx.runQuery(internal.gmail.oauth.credentialsFor, {
    accountId,
  });
  if (!credentials) throw new Error("No Gmail credentials for this account");
  if (credentials.expiry - EXPIRY_SKEW_MS > Date.now()) {
    return credentials.access_token;
  }

  const key = String(accountId);
  const existing = refreshInFlight.get(key);
  if (existing) return await existing;

  const pending = refreshAccessToken(ctx, accountId, credentials.refresh_token)
    .finally(() => refreshInFlight.delete(key));
  refreshInFlight.set(key, pending);
  return await pending;
}

async function refreshAccessToken(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  refreshToken: string,
): Promise<string> {
  const { clientId, clientSecret } = requireOauthConfig();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new GmailApiError(`Token refresh failed`, response.status, body);
  }
  const parsed = JSON.parse(body) as {
    access_token: string;
    expires_in: number;
  };
  await ctx.runMutation(internal.gmail.oauth.storeCredentials, {
    accountId,
    access_token: parsed.access_token,
    // A refresh response omits refresh_token; the mutation keeps the old one.
    expiry: Date.now() + parsed.expires_in * 1000,
  });
  return parsed.access_token;
}

export async function exchangeCodeForTokens(code: string) {
  const { clientId, clientSecret, redirectUrl } = requireOauthConfig();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUrl,
      grant_type: "authorization_code",
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new GmailApiError("Code exchange failed", response.status, body);
  }
  return JSON.parse(body) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };
}

export async function fetchUserInfo(accessToken: string) {
  const response = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new GmailApiError("userinfo failed", response.status, body);
  }
  return JSON.parse(body) as { email: string; name?: string; picture?: string };
}

// ---------------------------------------------------------------------------
// REST calls
// ---------------------------------------------------------------------------

/**
 * One authenticated call against any Google REST endpoint. The calendar
 * client shares it, so token handling and error shape never diverge between
 * the two APIs.
 */
export async function googleCall<T>(
  accessToken: string,
  url: string,
  init: RequestInit = {},
  label = "Google",
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = await response.text();
    if (response.ok) return (body ? JSON.parse(body) : {}) as T;
    // A burst (a search importing a page of threads, a backfill) trips the
    // per-user quota, which Google counts per minute, so the retries span one.
    if (attempt < RATE_LIMIT_RETRIES && isRateLimited(response.status, body)) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? NaN);
      const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : backoffMs(attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const path = url.replace(/^https:\/\/[^/]+/, "").split("?")[0];
    // Google's own sentence ("Calendar API has not been used in project…")
    // is what tells a person what to fix, so it rides in the message.
    const reason = googleErrorReason(body);
    throw new GmailApiError(
      `${label} ${init.method ?? "GET"} ${path} failed (${response.status})${reason ? `: ${reason}` : ""}`,
      response.status,
      body,
    );
  }
}

/** 2s, 4s, 8s, 16s, 32s: five retries wait out a full quota minute. */
const RATE_LIMIT_RETRIES = 5;

export function backoffMs(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** (attempt - 1));
}

/** The message Google puts in an error body, if the body is its JSON shape. */
function googleErrorReason(body: string): string | undefined {
  try {
    const message = (JSON.parse(body) as { error?: { message?: string } }).error?.message;
    return typeof message === "string" ? message.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/** Google says "slow down" as 429, or as 403 with a quota reason in the body. */
export function isRateLimited(status: number, body: string): boolean {
  return (
    status === 429 ||
    (status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body))
  );
}

async function call<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return await googleCall<T>(accessToken, `${GMAIL_API}${path}`, init, "Gmail");
}

export function queryString(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export async function listThreads(
  accessToken: string,
  params: { maxResults?: number; pageToken?: string; q?: string } = {},
) {
  return await call<{
    threads?: Array<{ id: string; snippet?: string; historyId?: string }>;
    nextPageToken?: string;
  }>(accessToken, `/threads${queryString(params)}`);
}

export async function getThread(accessToken: string, threadId: string) {
  return await call<{ id: string; messages?: GmailMessage[] }>(
    accessToken,
    `/threads/${threadId}${queryString({ format: "full" })}`,
  );
}

export async function getMessage(accessToken: string, messageId: string) {
  return await call<GmailMessage>(
    accessToken,
    `/messages/${messageId}${queryString({ format: "full" })}`,
  );
}

/** Every header on one message, in the order the message carries them. */
export async function getMessageHeaders(accessToken: string, messageId: string) {
  const message = await call<{ payload?: { headers?: Array<{ name: string; value: string }> } }>(
    accessToken,
    `/messages/${messageId}${queryString({ format: "metadata" })}`,
  );
  return message.payload?.headers ?? [];
}

export async function getAttachmentData(
  accessToken: string,
  messageId: string,
  attachmentId: string,
) {
  return await call<{ size: number; data: string }>(
    accessToken,
    `/messages/${messageId}/attachments/${attachmentId}`,
  );
}

export async function listLabels(accessToken: string) {
  return await call<{
    labels?: Array<{
      id: string;
      name: string;
      type?: string;
      color?: { backgroundColor?: string; textColor?: string };
    }>;
  }>(accessToken, "/labels");
}

export async function listHistory(
  accessToken: string,
  params: { startHistoryId: string; pageToken?: string; maxResults?: number },
) {
  return await call<GmailHistoryResponse>(
    accessToken,
    `/history${queryString(params)}`,
  );
}

/** Ask Gmail to publish this mailbox's changes to a Pub/Sub topic. Every
 *  change, every label: the sync mirrors the whole mailbox, not the inbox
 *  alone. Google answers with when the watch lapses (about seven days). */
export async function watchMailbox(accessToken: string, topicName: string) {
  return await call<{ historyId: string; expiration: string }>(accessToken, "/watch", {
    method: "POST",
    body: JSON.stringify({ topicName }),
  });
}

export async function getProfile(accessToken: string) {
  return await call<{ emailAddress: string; historyId: string }>(
    accessToken,
    "/profile",
  );
}

/** The addresses this mailbox may send as. Unverified aliases are left out:
 *  Gmail refuses to send from them. */
export async function listSendAs(accessToken: string): Promise<SendAs[]> {
  const res = await call<{
    sendAs?: Array<{ sendAsEmail: string; displayName?: string; isDefault?: boolean; verificationStatus?: string }>;
  }>(accessToken, "/settings/sendAs");
  return (res.sendAs ?? [])
    .filter((a) => !a.verificationStatus || a.verificationStatus === "accepted")
    .map((a) => ({
      email: a.sendAsEmail,
      ...(a.displayName ? { name: a.displayName } : {}),
      ...(a.isDefault ? { is_default: true } : {}),
    }));
}

export async function batchModify(
  accessToken: string,
  input: {
    ids: string[];
    addLabelIds?: string[];
    removeLabelIds?: string[];
  },
) {
  // Gmail takes at most 1000 ids per call; a topic archived whole can carry
  // more, so the modify goes out in pages.
  for (let at = 0; at < input.ids.length; at += BATCH_MODIFY_MAX) {
    await call(accessToken, "/messages/batchModify", {
      method: "POST",
      body: JSON.stringify({
        ids: input.ids.slice(at, at + BATCH_MODIFY_MAX),
        addLabelIds: input.addLabelIds ?? [],
        removeLabelIds: input.removeLabelIds ?? [],
      }),
    });
  }
}

const BATCH_MODIFY_MAX = 1000;

export async function batchDelete(accessToken: string, ids: string[]) {
  for (let at = 0; at < ids.length; at += BATCH_MODIFY_MAX) {
    await call(accessToken, "/messages/batchDelete", {
      method: "POST",
      body: JSON.stringify({ ids: ids.slice(at, at + BATCH_MODIFY_MAX) }),
    });
  }
}

/** Delete the Gmail draft holding a message. Drafts are addressed by draft
 *  id, which a synced message does not carry, so it is found by its message;
 *  one already gone is done. */
export async function deleteDraftByMessage(accessToken: string, messageId: string) {
  let pageToken: string | undefined;
  do {
    const page = await call<{
      drafts?: Array<{ id: string; message?: { id: string } }>;
      nextPageToken?: string;
    }>(accessToken, `/drafts${queryString({ maxResults: 500, pageToken })}`);
    const draft = page.drafts?.find((d) => d.message?.id === messageId);
    if (draft) {
      await call(accessToken, `/drafts/${draft.id}`, { method: "DELETE" });
      return;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
}

export async function sendMessage(
  accessToken: string,
  input: MimeInput & { threadId?: string },
) {
  type Sent = { id: string; threadId: string; labelIds?: string[] };
  const meta = input.threadId ? { threadId: input.threadId } : {};
  if (!input.attachments?.length) {
    return await call<Sent>(accessToken, "/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw: buildRawMessage(input), ...meta }),
    });
  }
  // The JSON `raw` field stops at 5 MB; files go through the upload endpoint,
  // which takes the message as it is (up to 35 MB) beside its metadata.
  const boundary = `=_whisk_upload_${Date.now().toString(36)}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n${buildMimeMessage(input)}\r\n--${boundary}--`;
  return await googleCall<Sent>(
    accessToken,
    `${GMAIL_UPLOAD_API}/messages/send?uploadType=multipart`,
    { method: "POST", headers: { "Content-Type": `multipart/related; boundary="${boundary}"` }, body },
    "Gmail",
  );
}

/** One attachment's bytes, looked up against the live message because the
 *  stored attachment id is only a hint (they are not stable across fetches).
 *  Null when the message has no such part. */
export async function fetchAttachmentBytes(
  accessToken: string,
  messageId: string,
  wanted: { attachmentId?: string; cid?: string; filename?: string },
): Promise<{ part: AttachmentPartRef; bytes: Uint8Array } | null> {
  const message = await getMessage(accessToken, messageId);
  const part = findAttachmentPart(message.payload, wanted);
  if (!part) return null;
  const payload = await getAttachmentData(accessToken, messageId, part.attachment_id);
  return { part, bytes: base64UrlToBytes(payload.data) };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type GmailHistoryResponse = {
  history?: Array<{
    id: string;
    messagesAdded?: Array<{ message: GmailMessage }>;
    messagesDeleted?: Array<{ message: GmailMessage }>;
    labelsAdded?: Array<{ message: GmailMessage; labelIds: string[] }>;
    labelsRemoved?: Array<{ message: GmailMessage; labelIds: string[] }>;
  }>;
  nextPageToken?: string;
  historyId?: string;
};

export type HistoryEffect = {
  /** Messages to fetch in full and upsert. */
  added: Array<{ messageId: string; threadId: string }>;
  /** Messages that no longer exist. */
  deleted: Array<{ messageId: string; threadId: string }>;
  /** Net label delta per message, collapsed across the whole page. */
  labelChanges: Map<
    string,
    { threadId: string; add: Set<string>; remove: Set<string> }
  >;
};

/**
 * Collapse a history page into the smallest set of writes that reproduces it.
 * Pure, so tests can drive synthetic payloads. Order matters: a label added
 * then removed inside the same page nets out to removed.
 */
export function collapseHistory(
  response: GmailHistoryResponse,
): HistoryEffect {
  const effect: HistoryEffect = {
    added: [],
    deleted: [],
    labelChanges: new Map(),
  };
  const deletedIds = new Set<string>();
  const addedIds = new Set<string>();

  const changeFor = (message: GmailMessage) => {
    let entry = effect.labelChanges.get(message.id);
    if (!entry) {
      entry = { threadId: message.threadId, add: new Set(), remove: new Set() };
      effect.labelChanges.set(message.id, entry);
    }
    return entry;
  };

  for (const record of response.history ?? []) {
    for (const item of record.messagesAdded ?? []) {
      if (addedIds.has(item.message.id)) continue;
      addedIds.add(item.message.id);
      effect.added.push({
        messageId: item.message.id,
        threadId: item.message.threadId,
      });
    }
    for (const item of record.messagesDeleted ?? []) {
      if (deletedIds.has(item.message.id)) continue;
      deletedIds.add(item.message.id);
      effect.deleted.push({
        messageId: item.message.id,
        threadId: item.message.threadId,
      });
    }
    for (const item of record.labelsAdded ?? []) {
      const entry = changeFor(item.message);
      for (const label of item.labelIds) {
        entry.remove.delete(label);
        entry.add.add(label);
      }
    }
    for (const item of record.labelsRemoved ?? []) {
      const entry = changeFor(item.message);
      for (const label of item.labelIds) {
        entry.add.delete(label);
        entry.remove.add(label);
      }
    }
  }

  // A message deleted in the same page needs no label work, and one that was
  // added will be fetched in full anyway.
  for (const id of deletedIds) effect.labelChanges.delete(id);
  for (const id of addedIds) effect.labelChanges.delete(id);
  effect.added = effect.added.filter((m) => !deletedIds.has(m.messageId));
  return effect;
}

import { v } from "convex/values";
import { httpAction, internalQuery, mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { accountsForUser, requireAccounts, rowsForToken, touchSession, userIdFromAuthJwt } from "../lib/auth";
import { recordUse } from "../lib/actionAuth";
import { mailReader, readerFor, seesId } from "../lib/privacy";
import { allowedOrigins } from "./oauth";
import { fetchAttachmentBytes, getAccessToken } from "./api";

// GET /gmail/attachment — stream one attachment (or cid: inline image) to the
// reader. The credential is the same bearer token the client already holds;
// the endpoint resolves it to an account and only serves parts of that
// account's own messages.
//
// Whisk's own clients put it in the query string, because an <img> tag cannot
// send headers. A connected app's token must come in an `Authorization:
// Bearer` header instead, from the app's server, which then serves the bytes
// itself: an app token is a standing credential for the person's whole
// mailbox, and a URL carrying it would land in a browser's history and in
// logs. So an app token in the query string is refused.

export const attachmentContext = internalQuery({
  // Exactly one of the two credentials is set: `token` is a legacy opaque
  // token; `userId` was resolved by attachmentDownload from a VERIFIED
  // Convex Auth JWT (the <img> tag cannot send headers, so the JWT rides the
  // query string and is checked against the deployment's JWKS).
  args: {
    token: v.optional(v.string()),
    /** The token arrived in the Authorization header, not the URL. */
    viaHeader: v.optional(v.boolean()),
    userId: v.optional(v.id("users")),
    messageGmailId: v.string(),
  },
  handler: async (ctx, { token, viaHeader, userId, messageGmailId }) => {
    if (token && !viaHeader && (await rowsForToken(ctx, token)).some((r) => r.app_id)) {
      throw new Error("Unauthorized: an app token goes in the Authorization header");
    }
    const reader = userId
      ? await readerFor(ctx, await accountsForUser(ctx, userId), false)
      : await mailReader(ctx, token);
    // The message may live in any of the caller's accounts; find its owner.
    for (const account of reader.accounts) {
      const message = await ctx.db
        .query("messages")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", account._id).eq("gmail_id", messageGmailId),
        )
        .unique();
      if (message && !message.deleted) {
        if (!(await seesId(ctx, reader, account._id, message.thread_gmail_id))) return null;
        return { accountId: account._id, provider: account.provider };
      }
    }
    return null;
  },
});

// Attachment bytes are third-party content: whoever sent the mail chose both
// the body and the MIME type Gmail reports. Echoing that type back with
// `Content-Disposition: inline` would let a crafted text/html or image/svg+xml
// attachment execute on the deployment origin — the same origin whose query
// string carries the reader's bearer token. So only raster images, the types
// the cid: inline renderer actually needs, are served inline; everything else
// downloads as an opaque blob and can never run.
const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

/** Strip parameters and case from a MIME type: `TEXT/HTML; charset=utf-8`
 *  and `text/html` must reach the allowlist as the same string. */
function normalizeMimeType(value: string): string {
  return value.split(";")[0].trim().toLowerCase();
}

/** Quotes, backslashes and control characters would break out of the quoted
 *  filename and forge extra response headers. */
function safeFilename(value: string): string {
  return value.replace(/["\\\r\n]/g, "_").replace(/[\x00-\x1f\x7f]/g, "_");
}

/**
 * The response headers for one attachment. Exported for the regression test:
 * the decision that matters is which types are allowed to render inline.
 */
export function attachmentHeaders(
  mimeType: string,
  filename: string,
  /** The page asking, when it is one of the app's own origins: it may then
   *  read the bytes with fetch() for an in-app preview. Any other origin
   *  gets the file but not the CORS grant. */
  origin?: string | null,
): Record<string, string> {
  const normalized = normalizeMimeType(mimeType);
  const inline = INLINE_SAFE_TYPES.has(normalized);
  const headers: Record<string, string> = {
    "Content-Type": inline ? normalized : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeFilename(filename)}"`,
    // Belt and braces: nosniff stops the browser from second-guessing the
    // type we chose, and the sandbox CSP neuters anything that renders anyway.
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=3600",
    Vary: "Origin",
  };
  if (origin && allowedOrigins().includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export const attachmentDownload = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const header = request.headers.get("Authorization") ?? "";
  const bearer = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
  const token = bearer || (url.searchParams.get("token") ?? "");
  const messageId = url.searchParams.get("message") ?? "";
  const attachmentId = url.searchParams.get("id") ?? undefined;
  const cid = url.searchParams.get("cid") ?? undefined;
  const filename = url.searchParams.get("name") ?? undefined;
  if (!token || !messageId || (!attachmentId && !cid)) {
    return new Response("Bad request", { status: 400 });
  }

  let context;
  try {
    // A Convex Auth JWT in the token slot is verified here (signature,
    // issuer, audience) and passed on as a user id; anything else goes down
    // the legacy opaque-token path.
    const jwtUserId = await userIdFromAuthJwt(token);
    context = await ctx.runQuery(
      internal.gmail.attachments.attachmentContext,
      jwtUserId
        ? { userId: jwtUserId, messageGmailId: messageId }
        : { token, viaHeader: bearer !== "", messageGmailId: messageId },
    );
    if (!jwtUserId) await recordUse(ctx, token);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!context) return new Response("Not found", { status: 404 });
  if (context.provider !== "gmail") {
    return new Response("This account has no fetchable attachments", {
      status: 404,
    });
  }

  try {
    const accessToken = await getAccessToken(ctx, context.accountId);
    const found = await fetchAttachmentBytes(accessToken, messageId, { attachmentId, cid, filename });
    if (!found) return new Response("Attachment not found", { status: 404 });
    return new Response(found.bytes as unknown as BodyInit, {
      status: 200,
      headers: attachmentHeaders(found.part.mime_type, filename ?? found.part.filename, request.headers.get("Origin")),
    });
  } catch {
    return new Response("Attachment fetch failed", { status: 502 });
  }
});

// Files going the other way. A client uploads bytes to a short-lived URL,
// then names the storage id in its sendMessage or saveDraft dispatch; the
// pump reads the bytes at send time and frees them once Gmail has them.
export const uploadUrl = mutation({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    await requireAccounts(ctx, token, "mail.draft");
    await touchSession(ctx, token);
    return await ctx.storage.generateUploadUrl();
  },
});

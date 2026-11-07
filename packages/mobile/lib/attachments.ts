import type { Attachment } from "@mail/shared/src/store/types";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { CONVEX_SITE_URL } from "./convex";

/** Streaming URL for one attachment of a message — the same token-gated
 *  /gmail/attachment endpoint the web reader uses. */
export function attachmentUrl(messageGmailId: string, a: Attachment): string | null {
  const token = mailStore.getState().authToken;
  if (!token) return null;
  const params = new URLSearchParams({
    token,
    message: messageGmailId,
    id: a.gmail_attachment_id,
    name: a.filename,
  });
  return `${CONVEX_SITE_URL}/gmail/attachment?${params.toString()}`;
}

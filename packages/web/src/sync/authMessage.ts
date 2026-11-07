// The OAuth popup posts the session token back to this window. Everything that
// decides whether to believe such a message lives here, as one pure function,
// so the rule is testable on its own and there is a single place to audit.

export type AuthMessage =
  | { kind: "token"; token: string }
  | { kind: "attached" };

/** What an incoming window message means, or null to ignore it.
 *
 *  Accepted ONLY from our own Convex site origin (the closing page is served by
 *  the Convex HTTP router, so that is the origin it posts from) and ONLY in the
 *  exact shapes that page sends — otherwise any page holding a handle to this
 *  window could inject a token and swap the user onto a mailbox the attacker
 *  controls.
 *
 *  A null expectedOrigin fails closed. It means VITE_CONVEX_SITE_URL is unset,
 *  and in that configuration gmailAuthUrl returns null, so no legitimate token
 *  message can arrive: there is nothing to lose by refusing them all.
 */
export function readAuthMessage(
  e: { origin: string; data: unknown },
  expectedOrigin: string | null,
): AuthMessage | null {
  if (!expectedOrigin || e.origin !== expectedOrigin) return null;
  const data = e.data as any;
  if (!data || typeof data !== "object") return null;
  if (data.type === "mail-auth" && typeof data.token === "string" && data.token) {
    return { kind: "token", token: data.token };
  }
  if (data.type === "mail-auth-attached") return { kind: "attached" };
  return null;
}

import { convexAuth } from "@convex-dev/auth/server";
import { createAuthConfig } from "@platform/auth/convex";
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import {
  authUserId,
  ensureUserForSessions,
  hasAuthIdentity,
  mergeUsers,
  sessionsForToken,
} from "./lib/auth";

// Sign-in is Google OAuth with the basic profile scope, through Convex Auth
// (ct-44709). This is identity only — the Gmail gmail.modify grant stays a
// mailbox CONNECTOR (gmail/oauth.ts) that attaches an account to the signed-in
// user; it signs nobody in. Deployment env this needs: AUTH_GOOGLE_ID,
// AUTH_GOOGLE_SECRET, SITE_URL, and the JWT_PRIVATE_KEY/JWKS pair from
// `npx @convex-dev/auth` setup.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth(
  createAuthConfig({
    redirect: { deepLinkSchemes: ["tersemail://"] },
    google: {},
  }),
);

/**
 * Fold a legacy opaque-token roster into the signed-in Convex Auth user, so
 * the person who was using whisk on this device keeps their mailboxes after
 * they sign in with Google.
 *
 * The only proof here is that the caller knows the token string, which is
 * weaker than it looks: a token is a bearer credential, and anyone who ever
 * read one holds the same proof. So this path stays inside what the token
 * already grants, and the two rules that keep it there are:
 *
 *  1. It refuses a roster that signs in on its own. A legacy user with a
 *     Convex Auth identity is somebody's account, not an unclaimed roster,
 *     and folding it in would hand its mailboxes and its sign-in to whoever
 *     presented the string. To join two accounts, connect the mailbox from
 *     the other one — a Google consent screen is real proof of one person.
 *     mergeUsers enforces the same rule underneath.
 *  2. Adopting spends the token. The rows behind it are deleted, exactly as
 *     signing out deletes them. The device doing the adopting signs in with
 *     Convex Auth from here on, so it needs no bearer credential, and a
 *     stolen copy of the string is dead the moment the owner adopts.
 *
 * What is left is a race the owner wins by signing in: a token stolen and
 * adopted first still moves that roster, which is the access the token
 * already gave. It can no longer become a sign-in that outlives revocation.
 */
export const adoptLegacySession = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await authUserId(ctx);
    if (!userId) throw new Error("Unauthorized: sign in first");
    const sessions = await sessionsForToken(ctx, token);
    if (sessions.length === 0) return { adopted: false, reason: "no-session" };
    const legacyUserId = await ensureUserForSessions(ctx, sessions);
    if (legacyUserId !== userId) {
      if (await hasAuthIdentity(ctx, legacyUserId)) {
        return { adopted: false, reason: "own-identity" };
      }
      await mergeUsers(ctx, userId, legacyUserId);
    }
    for (const session of sessions) await ctx.db.delete(session._id);
    return { adopted: true, reason: null };
  },
});

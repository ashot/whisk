import { api } from "@mail/convex/convex/_generated/api";
import { convexClient } from "./ConvexSync";
import { mailStore } from "../store/mailStore";
import { stashedRequest } from "./stashedRequest";

// Connecting another app (codecast first): it sends the person to
// whisk.email/connect?app=<id>&return=<url>&state=<s>. They sign in if
// needed, approve on one screen (AppConnect), and the browser returns to the
// app with a one-time code its server trades for an app token
// (convex/connect.ts). The server checks the app and its return URL on both
// the screen's read and the approval; nothing here is trusted.

export type AppConnectRequest = {
  app: string;
  returnUrl: string;
  state: string | null;
};

function fromLocation(location: Location): AppConnectRequest | null {
  if (location.pathname.replace(/\/+$/, "") !== "/connect") return null;
  const params = new URLSearchParams(location.search);
  const app = params.get("app") ?? "";
  const returnUrl = params.get("return") ?? "";
  if (!app || !returnUrl) return null;
  return { app, returnUrl, state: params.get("state") };
}

// /connect is served by index.html (public/_redirects); once read, the
// address bar goes back to the app's root.
const pending = stashedRequest("mail:app-connect", fromLocation, () => "/");

export const appConnectRequest = (): AppConnectRequest | null => pending.read();

export const clearAppConnect = (): void => pending.clear();

export function describeApp(request: AppConnectRequest) {
  return convexClient().query(api.connect.describe, {
    app_id: request.app,
    return_url: request.returnUrl,
    state: request.state ?? undefined,
  });
}

export type AppDescription = Awaited<ReturnType<typeof describeApp>>;

/** Approve, and get the return URL carrying the one-time code. A legacy
 *  session presents its token; a Convex Auth session resolves from the JWT. */
export function approveApp(request: AppConnectRequest): Promise<{ redirect: string }> {
  return convexClient().mutation(api.connect.approve, {
    token: mailStore.getState().authToken ?? undefined,
    app_id: request.app,
    return_url: request.returnUrl,
    state: request.state ?? undefined,
  });
}

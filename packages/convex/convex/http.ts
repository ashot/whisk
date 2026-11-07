import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { authStart, oauthCallback } from "./gmail/oauth";
import { attachmentDownload } from "./gmail/attachments";
import { receive as gmailPush } from "./gmail/watch";
import { exchange as appTokenExchange } from "./connect";

const http = httpRouter();

// Convex Auth's routes: /.well-known/*, /api/auth/signin, /api/auth/callback.
auth.addHttpRoutes(http);

// The popup opens /gmail/auth and the callback hands the token back through
// postMessage. Attachments stream through /gmail/attachment (token-gated).
// Google posts mailbox changes to /gmail/push (see gmail/watch.ts).
// Everything else talks to Convex functions directly.
http.route({ path: "/gmail/auth", method: "GET", handler: authStart });
http.route({
  path: "/gmail/oauth/callback",
  method: "GET",
  handler: oauthCallback,
});
http.route({
  path: "/gmail/attachment",
  method: "GET",
  handler: attachmentDownload,
});
http.route({ path: "/gmail/push", method: "POST", handler: gmailPush });

// A connected app's server trades a one-time code from whisk.email/connect
// for an app token (see connect.ts). Server to server: no CORS.
http.route({ path: "/apps/token", method: "POST", handler: appTokenExchange });

export default http;

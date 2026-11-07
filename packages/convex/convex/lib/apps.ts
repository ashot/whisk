import { v } from "convex/values";

// Other apps a person can connect to Whisk, and what each may do. A connected
// app holds an app token: an auth_sessions row like a terminal's device
// login, stamped with the app and its scopes. lib/auth resolves such a row
// only for a function that names a scope the row holds, so an app reaches
// exactly the functions the CLI calls that fall inside its grant, and nothing
// that names no scope (device logins, prefs, account disconnects).
//
// Codecast is the first app: it reaches mail and calendar only through Whisk,
// so Whisk's Google verification covers both products.
//
// This module is a leaf: it imports nothing from lib/auth (which imports it),
// so neither side can see the other half-loaded at module load.

/** What an app may do, with the words the consent screen and Settings show. */
export const APP_SCOPES = {
  "mail.read": "Read your mail",
  "mail.draft": "Write drafts",
  "mail.send": "Send mail as you",
  "mail.organize": "Organize your mail: archive, label, mark read, move to trash",
  "calendar.read": "Read your calendar",
  "calendar.write": "Add and change events on your calendar",
} as const;

export type AppScope = keyof typeof APP_SCOPES;

/**
 * Which mailboxes an app reaches, said on the consent screen and in Settings.
 * A grant belongs to the person, not to a list of addresses: like a second
 * Whisk client, the app works with every mailbox they keep in Whisk, so one
 * added later is in reach without a new consent. The screens say so plainly.
 */
export const APP_REACH =
  "It works with every mailbox you keep in Whisk, including any you add later.";

export const appScopeValidator = v.union(
  v.literal("mail.read"),
  v.literal("mail.draft"),
  v.literal("mail.send"),
  v.literal("mail.organize"),
  v.literal("calendar.read"),
  v.literal("calendar.write"),
);

export type ConnectedApp = {
  id: string;
  name: string;
  /** One line under the name on the consent screen. */
  blurb: string;
  scopes: AppScope[];
  /** Exact return URLs (origin and path; the query is ours to add). */
  returnUrls: string[];
  /** Env var holding the app's secret for the code exchange. Unset means the
   *  app cannot connect on this deployment: the exchange fails closed. */
  secretEnv: string;
  /** Env var with extra comma separated return URLs for this deployment
   *  (a staging or local codecast), so dev hosts never ship in code. */
  returnUrlsEnv: string;
};

const ALL_SCOPES = Object.keys(APP_SCOPES) as AppScope[];

const APPS: Record<string, ConnectedApp> = {
  codecast: {
    id: "codecast",
    name: "Codecast",
    blurb: "Your assistant in Codecast reads, drafts and sends mail and keeps your calendar through Whisk.",
    scopes: ALL_SCOPES,
    returnUrls: ["https://codecast.sh/connect/whisk"],
    secretEnv: "WHISK_APP_SECRET_CODECAST",
    returnUrlsEnv: "WHISK_APP_RETURN_URLS_CODECAST",
  },
};

/** The registered app with this id, or null. Own keys only, so a crafted id
 *  like "__proto__" or "toString" never resolves. */
export function connectedApp(id: string | undefined | null): ConnectedApp | null {
  if (!id || !Object.prototype.hasOwnProperty.call(APPS, id)) return null;
  return APPS[id];
}

/** The scopes a stored app row still holds: its grant, narrowed to what the
 *  app is registered for today. An app removed from the registry holds none. */
export function liveScopes(appId: string, granted: readonly string[] | undefined): AppScope[] {
  const app = connectedApp(appId);
  if (!app) return [];
  return app.scopes.filter((scope) => (granted ?? []).includes(scope));
}

/** What a function needs from an app token: one scope, or several that must
 *  all be held (a function that reads mail to organize it needs both). */
export type ScopeNeed = AppScope | readonly AppScope[];

export const scopeNeedValidator = v.union(appScopeValidator, v.array(appScopeValidator));

/** A login limited to scopes: a connected app's, or a terminal login for
 *  agents (`hides_private`). Every other login is the person's own. */
export function rowIsLimited(row: { app_id?: string; hides_private?: boolean }): boolean {
  return !!row.app_id || !!row.hides_private;
}

/** The scopes a limited row holds: an app's live grant, or an agent login's
 *  own list (every scope when it names none). */
export function rowScopes(row: { app_id?: string; scopes?: readonly string[] }): AppScope[] {
  if (row.app_id) return liveScopes(row.app_id, row.scopes);
  return row.scopes ? ALL_SCOPES.filter((scope) => row.scopes!.includes(scope)) : [...ALL_SCOPES];
}

/** Whether a stored login row may call a function that needs `need`. The
 *  person's own logins pass; a limited row never passes an empty need, so a
 *  function that names no scope (prefs, privacy rules, other logins) is the
 *  person's alone. */
export function appRowAllows(
  row: { app_id?: string; scopes?: string[]; hides_private?: boolean },
  need: ScopeNeed | undefined,
): boolean {
  if (!rowIsLimited(row)) return true;
  const needed: readonly AppScope[] = need === undefined ? [] : typeof need === "string" ? [need] : need;
  if (needed.length === 0) return false;
  const held = rowScopes(row);
  return needed.every((scope) => held.includes(scope));
}

export function scopeLabels(scopes: readonly AppScope[]): { scope: AppScope; label: string }[] {
  return scopes.map((scope) => ({ scope, label: APP_SCOPES[scope] }));
}

function returnUrlKey(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/**
 * Whether `raw` is a return URL this app registered. The comparison is exact
 * on origin and path: no prefix match, no credentials in the URL, no
 * fragment, and https unless the host is the local machine. The query string
 * may vary because the app may carry its own parameters; `whisk_code` and `state`
 * are always set by Whisk.
 */
export function isAllowedReturnUrl(app: ConnectedApp, raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return false;
  const extra = (process.env[app.returnUrlsEnv] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = new Set<string>();
  for (const entry of [...app.returnUrls, ...extra]) {
    try {
      allowed.add(returnUrlKey(new URL(entry)));
    } catch {
      // A malformed env entry allows nothing.
    }
  }
  return allowed.has(returnUrlKey(url));
}

/**
 * The query parameter the one-time code returns in. Not `code`: an app built
 * on Convex Auth (codecast is) has a provider that takes any `?code=` on page
 * load for its own sign-in, spends it and strips it from the URL, so the app
 * would never see ours.
 */
export const RETURN_CODE_PARAM = "whisk_code";

/** The parameters Whisk answers with on the return URL. */
export const RESULT_PARAMS = [RETURN_CODE_PARAM, "error", "state"] as const;

/**
 * The return URL with the result appended: `whisk_code` or `error`, and
 * `state`. Any of those already on the URL are dropped first. The allowlist
 * lets the query vary, so a crafted connect link could otherwise plant a
 * code of the attacker's own (or a state) that would survive a decline, or
 * an approve without a state, and reach the app as if Whisk had sent it.
 */
export function returnWith(
  raw: string,
  params: Partial<Record<(typeof RESULT_PARAMS)[number], string | undefined>>,
): string {
  const url = new URL(raw);
  for (const key of RESULT_PARAMS) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

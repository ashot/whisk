import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Where the CLI keeps its login. One file, owner-readable only. Every value
// can be overridden by an environment variable for agents that run without
// a home directory of their own.

export type Config = {
  convex_url?: string;
  site_url?: string;
  web_url?: string;
  token?: string;
  user_id?: string;
  email?: string;
  /** Snippet bookkeeping (see snippet.ts). */
  [key: string]: unknown;
};

export const DEFAULTS = {
  convex_url: "https://determined-fox-931.convex.cloud",
  site_url: "https://determined-fox-931.convex.site",
  web_url: "https://whisk.email",
};

export const CONFIG_DIR = path.join(process.env.WHISK_HOME || os.homedir(), ".whisk");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function readConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Config;
  } catch {
    return {};
  }
}

export function writeConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

export function updateConfig(patch: Config): Config {
  const next = { ...readConfig(), ...patch };
  writeConfig(next);
  return next;
}

/** Resolved settings: env wins over the file, the file over defaults. */
export function settings() {
  const config = readConfig();
  const convexUrl = process.env.WHISK_CONVEX_URL || config.convex_url || DEFAULTS.convex_url;
  return {
    convexUrl,
    siteUrl:
      process.env.WHISK_SITE_URL ||
      config.site_url ||
      (convexUrl === DEFAULTS.convex_url
        ? DEFAULTS.site_url
        : convexUrl.replace(".convex.cloud", ".convex.site")),
    webUrl: process.env.WHISK_WEB_URL || config.web_url || DEFAULTS.web_url,
    token: process.env.WHISK_TOKEN || config.token || null,
    email: config.email ?? null,
    userId: config.user_id ?? null,
  };
}

/**
 * The link that opens a thread in the app. No lookup: the id goes into the
 * hash as given (a thread id, or a message id the app resolves to its
 * thread), so a link costs nothing to make and the page opens straight
 * onto the thread.
 */
export function threadLink(id: string): string {
  return `${settings().webUrl}/#t/${encodeURIComponent(id.trim())}`;
}

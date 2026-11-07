import * as os from "os";
import type { Command } from "commander";
import open from "open";
import { AuthServer } from "@platform/auth/cli";
import { api } from "@mail/convex/convex/_generated/api";
import { c, fmt, icons } from "../colors";
import { mutation, query } from "../client";
import { CONFIG_FILE, readConfig, settings, updateConfig, writeConfig } from "../config";
import { refresh, session } from "../mail";
import { json, printAccounts } from "../output";
import { snippetStale } from "../snippet";
import { emit, jsonOption } from "./shared";

// Signing a terminal in. `whisk auth` opens the app with a nonce and the
// port of a localhost listener; the person clicks Authorize and the app
// mints a device login and POSTs it back. When the browser cannot reach the
// terminal (another machine), the app shows `whisk login <token>` instead.

function deviceLabel(): string {
  return `${os.userInfo().username}@${os.hostname()}`;
}

/** Store a login and learn who it belongs to. */
async function adopt(token: string, userId?: string): Promise<void> {
  updateConfig({ token, user_id: userId });
  const me = await query(api.devices.self, {});
  const s = await session();
  updateConfig({ email: s.accounts[0]?.email, device_id: me._id });
}

async function runAuth(): Promise<void> {
  const { webUrl } = settings();
  const server = new AuthServer({ port: 42425, timeout: 300_000 });
  const port = await server.listen();
  const url = `${webUrl}/?cli=1&nonce=${server.getNonce()}&port=${port}&device=${encodeURIComponent(deviceLabel())}`;

  console.log(`\n${c.bold}whisk${c.reset} ${fmt.muted("sign in")}\n`);
  const remote = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  if (remote) {
    console.log(`${fmt.muted("Remote shell: open this on your computer, then paste the command it shows:")}\n  ${fmt.accent(url)}\n`);
  } else {
    console.log(`${fmt.muted("Opening the browser. If nothing opens, visit:")}\n  ${fmt.accent(url)}\n`);
    try {
      await open(url);
    } catch {}
  }
  console.log(fmt.muted("Waiting for you to authorize (up to 5 minutes)…"));

  const result = await server.waitForCallback();
  server.stop();
  if (!result?.apiToken) {
    throw new Error(
      `Nothing arrived. If the page showed a ${fmt.cmd("whisk login <token>")} command, run that instead.`,
    );
  }
  await adopt(result.apiToken, result.userId);
  const s = await session();
  console.log(`\n${fmt.success(icons.check)} Signed in as ${fmt.bold(s.accounts.map((a) => a.email).join(", ") || "(no mailboxes yet)")}`);
  console.log(fmt.muted(`Login saved to ${CONFIG_FILE}`));
  if (readConfig().mail_snippet_enabled !== true) {
    console.log(`\nTeach your agents: ${fmt.cmd("whisk snippet install")}`);
  }
}

export function registerAuth(program: Command): void {
  program
    .command("auth")
    .description("sign this terminal in through the browser")
    .action(runAuth);

  program
    .command("login <token>")
    .description("sign in with a token from the app (Settings → Terminals, or the auth page)")
    .action(async (token: string) => {
      await adopt(token.trim());
      const s = await session();
      console.log(`${fmt.success(icons.check)} Signed in as ${s.accounts.map((a) => a.email).join(", ")}`);
    });

  program
    .command("logout")
    .description("revoke this terminal's login and forget it")
    .action(async () => {
      const config = readConfig();
      if (config.token) {
        try {
          const me = await query(api.devices.self, {});
          await mutation(api.devices.revoke, { session_id: me._id });
        } catch {
          // Already revoked or unreachable: forgetting locally is still right.
        }
      }
      const { token: _t, user_id: _u, email: _e, device_id: _d, ...rest } = config;
      writeConfig(rest);
      console.log("Signed out.");
    });

  const devices = program
    .command("devices")
    .description("terminals signed in to this mailbox");
  jsonOption(devices).action(async (opts: { json?: boolean }) => {
    const rows = await query(api.devices.list, {});
    emit(opts.json, rows, () => {
      for (const d of rows) {
        const seen = d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "never";
        const access = d.hides_private ? fmt.warning("agent   ") : fmt.muted("full    ");
        console.log(
          `${fmt.id(d._id)}  ${(d.device_name ?? "unnamed").padEnd(28)} ${access} ${fmt.muted("last seen " + seen)}${d.current ? fmt.accent("  (this terminal)") : ""}`,
        );
      }
    });
  });
  devices
    .command("revoke <id>")
    .description("end a terminal's access now")
    .action(async (id: string) => {
      await mutation(api.devices.revoke, { session_id: id as any });
      console.log(`Revoked ${id}.`);
    });

  jsonOption(program.command("status").description("who is signed in, the mailboxes, and writes still on the way")).action(
    async (opts: { json?: boolean }) => {
      const { email, convexUrl } = settings();
      const s = await session();
      emit(opts.json, { email, convex_url: convexUrl, ...s }, () => {
        printAccounts(s.accounts, s.outbound_pending, email);
        if (s.hides_private) console.log(fmt.muted(`This login can't see private mail (${fmt.cmd("whisk private")}).`));
        if (snippetStale()) console.log(fmt.warning(`Agent snippet is out of date: ${fmt.cmd("whisk snippet install")}`));
      });
    },
  );

  jsonOption(program.command("accounts").description("connected mailboxes")).action(async (opts: { json?: boolean }) => {
    const s = await session();
    emit(opts.json, s.accounts, () => printAccounts(s.accounts, 0, settings().email));
  });

  program
    .command("sync")
    .description("pull new mail from Gmail now")
    .action(async () => {
      const scheduled = await refresh();
      console.log(scheduled ? "Sync started." : "A sync is already running.");
    });

  program
    .command("config")
    .description("where the login lives and which backend it talks to")
    .action(() => json({ file: CONFIG_FILE, ...settings(), token: settings().token ? "(set)" : null }));
}

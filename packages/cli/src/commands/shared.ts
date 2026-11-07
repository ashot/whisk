import type { Command } from "commander";
import type { Account, Thread } from "@mail/shared/src/store/types";
import { fmt } from "../colors";
import { json } from "../output";
import { resolveThreads, session, waitForOutbound } from "../mail";

// What every command shares: the id list, the read scope, the --json switch
// and the --wait tail on writes.

export function ids(list: string[]): string[] {
  const flat = list.flatMap((x) => x.split(/[\s,]+/)).filter(Boolean);
  if (flat.length === 0) throw new Error("Give at least one thread id");
  return flat;
}

/** The account flag every read takes. */
export function accountOption(cmd: Command): Command {
  return cmd.option("-a, --account <who>", "only this mailbox (email, prefix or name)");
}

export function jsonOption(cmd: Command): Command {
  return cmd.option("--json", "machine output: the rows as the backend returns them");
}

export function waitOption(cmd: Command): Command {
  return cmd.option("--wait", "block until Gmail has applied the change (up to 30s)");
}

/** After a write: optionally wait for Gmail, then say so. */
export async function settle(opts: { wait?: boolean }): Promise<void> {
  if (!opts.wait) return;
  const pending = await waitForOutbound();
  if (pending > 0) console.log(fmt.warning(`${pending} write${pending === 1 ? "" : "s"} still pending after 30s`));
}

export { plural } from "@platform/cli-kit/text";

/** One thread from an id, with the account it lives in. */
export async function oneThread(id: string): Promise<{ thread: Thread; account: Account; accounts: Account[] }> {
  const [{ accounts }, [thread]] = await Promise.all([session(), resolveThreads([id])]);
  const account = accounts.find((a) => a._id === thread.account_id);
  if (!account) throw new Error("Thread belongs to an account this login cannot see");
  return { thread, account, accounts };
}

/** Print rows as JSON when asked, else run the text printer. */
export function emit(asJson: boolean | undefined, value: unknown, text: () => void): void {
  if (asJson) json(value);
  else text();
}

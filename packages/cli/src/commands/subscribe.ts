import * as path from "path";
import type { Command } from "commander";
import { registerSubscriptions, type SubscriptionSource } from "@platform/cli-kit/subscribe";
import { api } from "@mail/convex/convex/_generated/api";
import type { Thread } from "@mail/shared/src/store/types";
import { isOwnAddress } from "@mail/shared/src/lib/sendAs";
import { query } from "../client";
import { CONFIG_DIR } from "../config";
import { resolveThreads, session, threadMessages } from "../mail";

// `whisk subscribe <thread|address>`: wake the agent that is waiting on an
// answer. The cursor is the projection's sync stamp, so a check reads only
// threads that changed since the last one; `after` is the newest incoming
// message already reported, so a label change on old mail never wakes anyone.

type Data = { thread?: string; address?: string; after: number };

export const mailSubscriptions: SubscriptionSource = {
  cli: "whisk",
  noun: "email",
  file: path.join(CONFIG_DIR, "subscriptions.json"),

  async resolve(target) {
    const now = Date.now();
    if (target.includes("@")) {
      const address = target.trim().toLowerCase();
      const data: Data = { address, after: now };
      return { key: `from:${address}`, label: address, read: `whisk search "from:${address}" -n 5`, cursor: now, data };
    }
    const [thread] = await resolveThreads([target]);
    const data: Data = { thread: thread!.gmail_id, after: now };
    return {
      key: `thread:${thread!.gmail_id}`,
      label: `"${thread!.subject || "(no subject)"}"`,
      read: `whisk read ${thread!.gmail_id}`,
      cursor: now,
      data,
    };
  },

  async incoming(sub) {
    const data = sub.data as Data;
    const page = (await query(api.sync.listThreads, { since: sub.cursor })) as { rows: Thread[]; nextSince: number };
    const touched = page.rows.filter((t) =>
      data.thread ? t.gmail_id === data.thread : t.participants.some((p) => p.email.toLowerCase() === data.address),
    );
    if (touched.length === 0) return { count: 0, cursor: Math.max(sub.cursor, page.nextSince) };

    const accounts = new Map((await session()).accounts.map((a) => [a._id, a]));
    let count = 0;
    let after = data.after;
    for (const thread of touched) {
      const account = accounts.get(thread.account_id);
      for (const m of await threadMessages(thread)) {
        if (m.deleted || m.date <= data.after) continue;
        if (account && isOwnAddress(account, m.from.email)) continue;
        if (data.address && m.from.email.toLowerCase() !== data.address) continue;
        count++;
        after = Math.max(after, m.date);
      }
    }
    return { count, cursor: Math.max(sub.cursor, page.nextSince), data: { ...data, after } };
  },
};

export function registerSubscribe(program: Command): void {
  registerSubscriptions(program, mailSubscriptions, "in a thread (id) or from a sender (address)");
}

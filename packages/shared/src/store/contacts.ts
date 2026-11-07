import { L, type Account, type Address, type Message, type Thread } from "./types";

// Whisk has no address book. The people you write to are the people already
// in the mailbox: every thread's participants, every synced message's from,
// to and cc. This builds that list once per store change and answers
// autocomplete queries from it, all local, all instant.

export type Contact = Address & {
  /** How often and how recently this address appears; higher ranks first. */
  score: number;
};

type Acc = { name?: string; nameAt: number; score: number };

const DAY = 86_400_000;

/** Recent mail counts for more than old mail: full weight this month, and
 *  it fades to a floor over a year. */
function recency(at: number, now: number): number {
  const age = Math.max(0, now - at) / DAY;
  return age < 30 ? 1 : Math.max(0.2, 1 - (age - 30) / 365);
}

/** Addresses nobody writes to on purpose: unattended senders, and the
 *  one-off relay addresses marketplaces and ticketing systems mint per
 *  conversation (a long run of hex or base64 before the @). */
const NOISE_LOCAL = /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounces?|postmaster)([.+-]|$)/;
const TOKEN_LOCAL = /^[a-z0-9+=_-]{20,}$/;
export function isMachineAddress(email: string): boolean {
  const at = email.indexOf("@");
  const local = at >= 0 ? email.slice(0, at) : email;
  return NOISE_LOCAL.test(local) || (TOKEN_LOCAL.test(local) && !local.includes("."));
}

function note(acc: Map<string, Acc>, a: Address, weight: number, at: number): void {
  const email = a.email.trim().toLowerCase();
  if (!email.includes("@") || isMachineAddress(email)) return;
  let row = acc.get(email);
  if (!row) {
    row = { nameAt: 0, score: 0 };
    acc.set(email, row);
  }
  row.score += weight;
  // The newest name wins: people rename themselves, mailers don't.
  const name = a.name?.trim();
  if (name && at >= row.nameAt && !/@/.test(name)) {
    row.name = name;
    row.nameAt = at;
  }
}

let lastThreads: Record<string, Thread> | null = null;
let lastMessages: Record<string, Message[]> | null = null;
let lastAccounts: Record<string, Account> | null = null;
let lastIndex: Contact[] = [];

/** Every address in the mailbox, ranked. The user's own accounts are left
 *  out. Memoized on the store collections, so it rebuilds only when a row
 *  moved. */
export function contactIndex(
  threads: Record<string, Thread>,
  messages: Record<string, Message[]>,
  accounts: Record<string, Account>,
  now = Date.now(),
): Contact[] {
  if (threads === lastThreads && messages === lastMessages && accounts === lastAccounts) return lastIndex;
  lastThreads = threads;
  lastMessages = messages;
  lastAccounts = accounts;

  const me = new Set(Object.values(accounts).map((a) => a.email.toLowerCase()));
  const acc = new Map<string, Acc>();
  for (const t of Object.values(threads)) {
    if (t.deleted) continue;
    // A thread you took part in says more than one that only arrived.
    const weight = t.label_ids.includes(L.SENT) ? 3 : 1;
    for (const p of t.participants) note(acc, p, weight * recency(t.last_at, now), t.last_at);
  }
  for (const list of Object.values(messages)) {
    for (const m of list) {
      if (m.deleted) continue;
      const r = recency(m.date, now);
      const mine = me.has(m.from.email.toLowerCase());
      note(acc, m.from, r, m.date);
      // The people you addressed yourself are the ones you will address again.
      for (const a of [...m.to, ...(m.cc ?? [])]) note(acc, a, (mine ? 4 : 1) * r, m.date);
    }
  }
  for (const email of me) acc.delete(email);
  lastIndex = [...acc.entries()]
    .map(([email, row]) => ({ email, name: row.name, score: row.score }))
    .sort((a, b) => b.score - a.score);
  return lastIndex;
}

/** How well a contact answers a typed prefix: the start of the address or
 *  of the whole name is best, the start of any later name word or of the
 *  domain is fine, anything else is not a match. */
function matchRank(c: Contact, q: string): number {
  const email = c.email;
  const name = c.name?.toLowerCase() ?? "";
  if (email.startsWith(q) || name.startsWith(q)) return 2;
  if (name.split(/\s+/).some((w) => w.startsWith(q))) return 1.5;
  const at = email.indexOf("@");
  if (at >= 0 && email.slice(at + 1).startsWith(q)) return 1;
  if (email.includes(q) || name.includes(q)) return 0.5;
  return 0;
}

/** The best matches for what the person has typed so far. An empty query
 *  answers with the people they write to most. */
export function suggestContacts(
  index: Contact[],
  query: string,
  exclude: Iterable<string> = [],
  limit = 6,
): Contact[] {
  const q = query.trim().toLowerCase();
  const taken = new Set([...exclude].map((e) => e.toLowerCase()));
  const hits: { c: Contact; rank: number }[] = [];
  for (const c of index) {
    if (taken.has(c.email)) continue;
    const rank = q ? matchRank(c, q) : 1;
    if (rank > 0) hits.push({ c, rank });
  }
  return hits
    .sort((a, b) => b.rank - a.rank || b.c.score - a.c.score)
    .slice(0, limit)
    .map((h) => h.c);
}

/** Who a recipient field offers for what has been typed into it, leaving
 *  out the people already on it. Nothing typed, nothing offered. */
export function suggestRecipients(
  s: {
    threads: Record<string, Thread>;
    threadMessages: Record<string, Message[]>;
    accounts: Record<string, Account>;
  },
  text: string,
  taken: readonly Address[],
): Contact[] {
  if (!text.trim()) return [];
  const index = contactIndex(s.threads, s.threadMessages, s.accounts);
  return suggestContacts(index, text, taken.map((a) => a.email));
}

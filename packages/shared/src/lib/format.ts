import type { Address, Message, Thread } from "../store/types";
import { isOwnAddress, type Sender } from "./sendAs";

export function relativeDate(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const diff = now - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function fullDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A person's short name; any of my own addresses reads "me". */
export function displayName(a: Address, me?: Sender): string {
  if (me && isOwnAddress(me, a.email)) return "me";
  if (a.name) return a.name;
  return a.email.split("@")[0];
}

/** "to Ada, Grace + me" under a message's sender, "to me" when it went to
 *  the reader alone. Null only when the message names no recipient at all
 *  (a Bcc, an undisclosed list). */
export function recipientsLine(m: Pick<Message, "to" | "cc">, me?: Sender): string | null {
  const mine = (a: Address) => !!me && isOwnAddress(me, a.email);
  const all = [...m.to, ...(m.cc ?? [])];
  const others = all.filter((a) => !mine(a));
  if (all.length === 0) return null;
  if (others.length === 0) return "to me";
  return `to ${others.map((a) => displayName(a, me)).join(", ")}${all.some(mine) ? " + me" : ""}`;
}

/** The address headers of a message, as labelled rows; empty ones left out. */
export function addressRows(m: Message): Array<{ label: string; people: Address[] }> {
  const rows = [
    { label: "From", people: [m.from] },
    { label: "To", people: m.to },
    { label: "Cc", people: m.cc ?? [] },
    { label: "Bcc", people: m.bcc ?? [] },
    { label: "Reply-To", people: m.reply_to ? [m.reply_to] : [] },
  ];
  return rows.filter((r) => r.people.length > 0);
}

/** "Ada, Grace 2" — Gmail-style participants line for a thread row. */
export function participantsLine(t: Thread, me?: Sender): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const p of t.participants) {
    const n = displayName(p, me);
    const first = n.split(" ")[0];
    if (!seen.has(first)) {
      seen.add(first);
      names.push(first);
    }
  }
  const line = names.slice(0, 3).join(", ");
  return t.message_count > 1 ? `${line} ${t.message_count}` : line;
}

export function initials(a: Address): string {
  const n = a.name?.trim();
  if (n) {
    const parts = n.split(/\s+/);
    return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
  }
  return a.email.slice(0, 2).toUpperCase();
}

/** Deterministic hue for a sender avatar, held inside the warm arc the palette
 *  lives in — terracotta (15°) through gold (90°). A full 360° spin would put
 *  cyan and violet avatars in a room that has no other cool colour in it. */
export function senderHue(email: string): number {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return 15 + (h % 75);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

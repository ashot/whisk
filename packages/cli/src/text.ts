import { parseAddresses as parseAddressList } from "@mail/shared/src/lib/compose";
import type { Address, Message } from "@mail/shared/src/store/types";

// Text plumbing: bodies in (argument, file or stdin), HTML out (to plain
// text for the terminal), and address lists as people type them.

export { readBody } from "@platform/cli-kit/text";

/** "Ada Lovelace <ada@x.org>, grace@y.org" → addresses. Anything that is
 *  not an address is an error, not a silent drop. */
export function parseAddresses(input: readonly string[] | string | undefined): Address[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input.join(",") : (input as string);
  const { addresses, invalid } = parseAddressList(raw);
  if (invalid.length) throw new Error(`Not an email address: "${invalid[0]}"`);
  return addresses;
}

export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function formatAddresses(list: readonly Address[] | undefined): string {
  return (list ?? []).map(formatAddress).join(", ");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** A readable plain-text rendering of an HTML body: block tags become line
 *  breaks, links keep their targets, everything else is dropped. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|section|article|table)>/gi, "\n")
    .replace(/<(p|div|tr|h[1-6]|blockquote|section|article|table)(\s[^>]*)?>/gi, "\n")
    .replace(/<li(\s[^>]*)?>/gi, "\n- ")
    .replace(/<td(\s[^>]*)?>/gi, " ")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      if (!text || text === href) return href;
      return /^(https?:|mailto:)/i.test(href) ? `${text} (${href})` : text;
    })
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The body to show for a message: its text part, else its HTML as text. */
export function messageText(m: Pick<Message, "body_text" | "body_html" | "snippet">): string {
  if (m.body_text?.trim()) return m.body_text.replace(/\r\n/g, "\n").trim();
  if (m.body_html) return htmlToText(m.body_html);
  return m.snippet;
}

/** The new content of a message: quoted trails and signatures dropped. */
export { newContent as stripQuotes } from "@mail/shared/src/lib/quotes";

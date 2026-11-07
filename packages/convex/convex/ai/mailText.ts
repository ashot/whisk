// Turning stored messages into model-readable transcript lines. One place, so
// drafts, summaries and the style profile all read mail the same way.

import { newContent } from "@mail/shared/src/lib/quotes";

/** Body text with quoted trails and signatures dropped, whitespace collapsed,
 *  clamped to `max` characters. */
export function readableBody(
  message: { body_text?: string; snippet: string },
  max = 1200,
): string {
  const flat = newContent(message.body_text ?? message.snippet);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function transcriptOf(
  messages: Array<{
    from: { name?: string; email: string };
    date: number;
    body_text?: string;
    snippet: string;
  }>,
  opts: { perMessage?: number; lastN?: number } = {},
): string {
  const lastN = opts.lastN ?? 8;
  const slice = messages.slice(-lastN);
  return slice
    .map((m) => {
      const who = m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email;
      const when = new Date(m.date).toISOString().slice(0, 10);
      return `From: ${who} (${when})\n${readableBody(m, opts.perMessage)}`;
    })
    .join("\n\n———\n\n");
}

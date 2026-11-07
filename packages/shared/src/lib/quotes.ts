// Quoted trails: the earlier messages a reply carries below its new content.
// One place decides what a quote looks like, so the thread view that folds
// them, the CLI that trims them and the AI context that drops them agree.
// Platform-free: text in, text out. The web's HTML splitter (a DOM walk)
// reuses parseAttribution and isForwardHeader from here.

export interface QuoteAttribution {
  /** Who wrote the quoted message: display name, else address. */
  name?: string;
  /** When, if the header's date reads unambiguously. */
  date?: number;
}

export interface QuoteSplit {
  fresh: string;
  quoted: string;
  attribution: QuoteAttribution | null;
  /** How many earlier messages the trail holds (headers found, at least 1). */
  count: number;
}

const FORWARD_RE =
  /(?:^|\s)(?:-{2,}\s*Forwarded message\s*-{2,}|—{2,}\s*Forwarded message\s*—{2,}|Begin forwarded message:)|\bSubject:\s*(?:Fw|Fwd):/i;

/** A forward's header: its content is the point of the message, never folded. */
export function isForwardHeader(text: string): boolean {
  return FORWARD_RE.test(text);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";

/** Dates as mail clients write them in reply headers ("Wed, Apr 29, 2026 at
 *  6:14 PM", "Wednesday, April 29, 2026 4:12 PM", "29 Apr 2026 18:14").
 *  All-numeric dates are ambiguous across locales and read as unknown. */
export function parseHeaderDate(text: string): number | undefined {
  const s = text.toLowerCase();
  const year = s.match(/\b(19|20)\d{2}\b/);
  const monthFirst = s.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})\\b`));
  const dayFirst = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}`));
  const month = monthFirst?.[1] ?? dayFirst?.[2];
  const day = monthFirst ? Number(monthFirst[2]) : dayFirst ? Number(dayFirst[1]) : NaN;
  if (!year || !month || !(day >= 1 && day <= 31)) return undefined;
  let hours = 0;
  let minutes = 0;
  const time = s.match(/\b(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap])?\.?m?\b/);
  if (time) {
    hours = Number(time[1]) % 24;
    minutes = Number(time[2]);
    if (time[3] === "p" && hours < 12) hours += 12;
    if (time[3] === "a" && hours === 12) hours = 0;
  }
  const d = new Date(Number(year[0]), MONTHS.indexOf(month), day, hours, minutes);
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

const EMAIL_RE = /[^\s<>"'(),;]+@[^\s<>"'(),;]+\.[a-z]{2,}/i;

function who(raw: string): string | undefined {
  const email = raw.match(EMAIL_RE)?.[0];
  const name = raw
    .replace(/<[^>]*>/g, "")
    .replace(/\[?mailto:[^\]\s]*\]?/gi, "")
    .replace(EMAIL_RE, "")
    .replace(/^[\s,'"]+|[\s,'"]+$/g, "");
  return name || email;
}

/** Who and when, from the header line a client writes above a quote:
 *  "On <date>, <name> <email> wrote:" or an Outlook "From: … Sent: …" block. */
export function parseAttribution(text: string): QuoteAttribution | null {
  const t = text.replace(/[\s ]+/g, " ");
  const wrote = t.match(/\bOn (.{6,200}?) wrote:/);
  if (wrote) {
    const inner = wrote[1];
    // Everything up to the last clock time is the date; the rest is the sender.
    const times = [...inner.matchAll(/\d{1,2}[:.]\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?/g)];
    const last = times[times.length - 1];
    if (last && last.index !== undefined) {
      const cut = last.index + last[0].length;
      return { name: who(inner.slice(cut)), date: parseHeaderDate(inner.slice(0, cut)) };
    }
    return { name: who(inner.replace(/^.*\d{4},?/, "")), date: parseHeaderDate(inner) };
  }
  const from = t.match(/\bFrom:\s*(.+?)\s*(?:Sent|Date):\s*(.+?)\s*(?:(?:To|Cc|Subject):|$)/);
  if (from) return { name: who(from[1]), date: parseHeaderDate(from[2]) };
  return null;
}

const QUOTED_LINE = /^\s*>/;

/** Where a quote header starts at line i, if one does. */
function headerAt(lines: readonly string[], i: number): boolean {
  const line = lines[i];
  if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) return true;
  // Clients wrap long "On … wrote:" lines, so look a couple of lines ahead.
  if (/^\s*On\s/.test(line) && lines.slice(i, i + 3).some((l) => /wrote:\s*$/.test(l))) return true;
  if (/^\s*From:\s/.test(line)) {
    return lines.slice(i + 1, i + 5).some((l) => /^\s*(Sent|Date):\s/.test(l));
  }
  return false;
}

/** Where the text stops being the writer's own: the line its quoted trail
 *  starts on, or -1 when there is none or a forward comes first (a forward's
 *  content is the point of the message). */
function quoteStart(lines: readonly string[]): { at: number; forward: boolean } {
  for (let i = 0; i < lines.length; i++) {
    if (isForwardHeader(lines[i])) return { at: -1, forward: true };
    if (headerAt(lines, i)) {
      // An Outlook forward is a header block naming "Subject: FW:"; a forward
      // quoted under a reply's attribution is just the trail.
      const block = lines.slice(i, i + 8).filter((l) => !QUOTED_LINE.test(l));
      return isForwardHeader(block.join("\n")) ? { at: -1, forward: true } : { at: i, forward: false };
    }
    if (QUOTED_LINE.test(lines[i]) && lines.slice(i).every((l) => !l.trim() || QUOTED_LINE.test(l))) {
      return { at: i, forward: false };
    }
  }
  return { at: -1, forward: false };
}

const textLines = (text: string) => text.replace(/\r\n/g, "\n").split("\n");

/** Whether the text forwards a message, rather than answering one: a
 *  forward header before any quoted trail. One quoted further down is just
 *  part of the conversation being answered. */
export function opensForward(text: string): boolean {
  return quoteStart(textLines(text)).forward;
}

/** What the writer wrote above the quoted trail, empty when the text is only
 *  a quote. For a draft picked up to keep writing, not for display. */
export function writtenPart(text: string): string {
  const lines = textLines(text);
  const { at } = quoteStart(lines);
  return (at < 0 ? lines : lines.slice(0, at)).join("\n").trim();
}

/** Split plain-text mail into what this message says and the trail it quotes.
 *  A run of ">" lines only counts as a trail when nothing but quotes follows;
 *  interleaved inline replies stay whole. Forwards are never split. */
export function splitQuotedText(text: string): QuoteSplit | null {
  const lines = textLines(text);
  const start = quoteStart(lines).at;
  if (start < 0) return null;
  const fresh = lines.slice(0, start).join("\n").trimEnd();
  if (!fresh.trim()) return null;
  const quotedLines = lines.slice(start);
  const headers = quotedLines
    .map((l) => l.replace(/^[\s>]+/, ""))
    .filter((_, i, all) => headerAt(all, i)).length;
  return {
    fresh,
    quoted: quotedLines.join("\n").trim(),
    attribution: parseAttribution(quotedLines.slice(0, 8).join(" ")),
    count: Math.max(1, headers),
  };
}

/** Only what this message itself says: quoted trail, stray quoted lines,
 *  signature and forwarded content dropped. For reading surfaces that want the
 *  new words alone (CLI default read, AI context). */
export function newContent(text: string): string {
  const body = splitQuotedText(text)?.fresh ?? text;
  const kept: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    if (QUOTED_LINE.test(line)) continue;
    if (/^\s*On .+ wrote:\s*$/.test(line)) break;
    if (/^--\s*$/.test(line)) break;
    if (isForwardHeader(line)) break;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

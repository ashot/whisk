// The search grammar both passes share: the live filter over the local
// projection (client) and the projection search on the server. Gmail itself
// receives the raw query and understands far more; this covers the operators
// a projection row can answer.

export type ParsedQuery = {
  terms: string[];
  from: string[];
  to: string[];
  labels: string[];
  isUnread: boolean;
  isStarred: boolean;
  hasAttachment: boolean;
};

/**
 * Split a query into free text plus the handful of operators that carry their
 * weight: from:, to:, label:, is:unread, is:starred, has:attachment.
 */
export function parseQuery(raw: string): ParsedQuery {
  const parsed: ParsedQuery = {
    terms: [],
    from: [],
    to: [],
    labels: [],
    isUnread: false,
    isStarred: false,
    hasAttachment: false,
  };
  // Quoted phrases stay whole; everything else splits on whitespace.
  const tokens = raw.match(/"[^"]*"|\S+/g) ?? [];
  for (const token of tokens) {
    const bare = token.replace(/^"|"$/g, "");
    const colon = bare.indexOf(":");
    const operator = colon > 0 ? bare.slice(0, colon).toLowerCase() : "";
    const value = colon > 0 ? bare.slice(colon + 1).toLowerCase() : "";
    if (operator === "from" && value) parsed.from.push(value);
    else if (operator === "to" && value) parsed.to.push(value);
    else if (operator === "label" && value) parsed.labels.push(value);
    else if (operator === "is" && value === "unread") parsed.isUnread = true;
    else if (operator === "is" && value === "starred") parsed.isStarred = true;
    else if (operator === "has" && value === "attachment") {
      parsed.hasAttachment = true;
    } else if (bare.trim()) parsed.terms.push(bare.toLowerCase());
  }
  return parsed;
}

export function isEmptyQuery(parsed: ParsedQuery): boolean {
  return (
    parsed.terms.length === 0 &&
    parsed.from.length === 0 &&
    parsed.to.length === 0 &&
    parsed.labels.length === 0 &&
    !parsed.isUnread &&
    !parsed.isStarred &&
    !parsed.hasAttachment
  );
}

export type SearchableThread = {
  subject: string;
  snippet: string;
  participants: Array<{ name?: string; email: string }>;
  label_ids: string[];
  is_unread: boolean;
  is_starred: boolean;
  has_attachments: boolean;
};

/** Every free-text term must appear somewhere; operators are all conjunctive. */
export function matchThread(
  thread: SearchableThread,
  parsed: ParsedQuery,
  labelNameById: Map<string, string> = new Map(),
): boolean {
  if (parsed.isUnread && !thread.is_unread) return false;
  if (parsed.isStarred && !thread.is_starred) return false;
  if (parsed.hasAttachment && !thread.has_attachments) return false;

  const people = thread.participants
    .map((p) => `${p.name ?? ""} ${p.email}`.toLowerCase())
    .join(" ");
  for (const needle of parsed.from) {
    if (!people.includes(needle)) return false;
  }
  // The projection has no per-thread recipient list, so `to:` searches the same
  // participant set. It still narrows a mailbox usefully and never lies about
  // more precision than exists.
  for (const needle of parsed.to) {
    if (!people.includes(needle)) return false;
  }
  for (const wanted of parsed.labels) {
    const hit = thread.label_ids.some((id) => {
      if (id.toLowerCase() === wanted) return true;
      const name = labelNameById.get(id);
      return !!name && name.toLowerCase() === wanted;
    });
    if (!hit) return false;
  }

  if (parsed.terms.length === 0) return true;
  const haystack = `${thread.subject} ${thread.snippet} ${people}`.toLowerCase();
  return parsed.terms.every((term) => haystack.includes(term));
}

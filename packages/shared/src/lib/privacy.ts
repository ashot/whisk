// Private mail: threads the person keeps away from agents. They describe
// what is private in a few plain sentences (rules); the server's model reads
// each thread against them and stores its verdict on the thread row, and the
// person can mark any thread private or not private by hand, which is final.
//
// Who can see private mail is a property of the login, not of the screen:
// the person's own app and full terminal logins see everything; a terminal
// login restricted for agents, and every connected app, never see a thread
// that is private or not yet checked. The server enforces that on every
// read and write (convex/lib/privacy.ts); this module is the one definition
// of a thread's state that the server, the CLI and the app share.

export const MAX_PRIVACY_RULES = 20;
export const MAX_PRIVACY_RULE = 500;

/** One rule as the person's prefs hold it. `revision` moves when the text
 *  changes, so a verdict judged under older wording is stale. */
export type PrivacyRule = {
  id: string;
  text: string;
  revision: number;
  created_at: number;
};

/** A thread's privacy fields, as both the server row and the client carry. */
export type PrivacyFields = {
  message_count: number;
  /** The person's word: true private, false not private. Final. */
  private_mark?: boolean;
  /** Rule ids the model found the thread falls under. */
  private_hits?: string[];
  /** Rule keys (`ruleKey`) the model has read the thread against. */
  private_checked?: string[];
  /** message_count when the model last read it; new mail means a new read. */
  private_count?: number;
  /** The model's few words on why it is private. */
  private_why?: string;
};

/**
 * - private: hidden from agents.
 * - pending: rules exist and the model has not read this thread against all
 *   of them since its last message; hidden from agents until it has.
 * - open: agents may see it.
 */
export type PrivacyState = "private" | "pending" | "open";

/** A rule's identity at its current wording. */
export function ruleKey(rule: Pick<PrivacyRule, "id" | "revision">): string {
  return `${rule.id}:${rule.revision}`;
}

export function privacyRulesFromPrefs(prefs: { privacy_rules?: unknown } | undefined | null): PrivacyRule[] {
  const raw = Array.isArray(prefs?.privacy_rules) ? (prefs!.privacy_rules as Partial<PrivacyRule>[]) : [];
  const out: PrivacyRule[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r.id !== "string" || !r.id || seen.has(r.id)) continue;
    const text = typeof r.text === "string" ? r.text.trim().slice(0, MAX_PRIVACY_RULE) : "";
    if (!text) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      text,
      revision: typeof r.revision === "number" ? r.revision : 1,
      created_at: typeof r.created_at === "number" ? r.created_at : 0,
    });
  }
  return out.slice(0, MAX_PRIVACY_RULES);
}

/**
 * Where a thread stands. A hand mark decides alone. A rule hit stays private
 * even after new mail (it was private, and stays so until the model reads it
 * again); a thread with no hit is open only once the model has read its
 * current messages against every current rule.
 */
export function threadPrivacy(t: PrivacyFields, rules: readonly PrivacyRule[]): PrivacyState {
  if (t.private_mark !== undefined) return t.private_mark ? "private" : "open";
  if (rules.length === 0) return "open";
  const live = new Set(rules.map((r) => r.id));
  if ((t.private_hits ?? []).some((id) => live.has(id))) return "private";
  if (t.private_count !== t.message_count) return "pending";
  const checked = new Set(t.private_checked ?? []);
  return rules.every((r) => checked.has(ruleKey(r))) ? "open" : "pending";
}

/** The rules a thread still needs reading against: every rule when its
 *  messages changed since the last read, else the ones it was never read
 *  against at their current wording. Empty for a hand-marked thread. */
export function rulesToCheck(t: PrivacyFields, rules: readonly PrivacyRule[]): PrivacyRule[] {
  if (t.private_mark !== undefined) return [];
  if (t.private_count !== t.message_count) return [...rules];
  const checked = new Set(t.private_checked ?? []);
  return rules.filter((r) => !checked.has(ruleKey(r)));
}

/** The rules a thread was found to fall under, in rule order. */
export function matchedRules(t: PrivacyFields, rules: readonly PrivacyRule[]): PrivacyRule[] {
  const hits = new Set(t.private_hits ?? []);
  return rules.filter((r) => hits.has(r.id));
}

export function newPrivacyRuleId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

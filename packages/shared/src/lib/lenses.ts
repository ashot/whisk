// Lenses: the inbox seen through descriptions the person writes. Each lens
// is a sentence or two of what belongs in it; the server's model scores
// every inbox thread against every lens (0-100) and the lens shows the
// threads at or above its cutoff. Important is the built-in lens: the inbox
// opens on it, and Other is everything it leaves out. Moving a cutoff is a
// local filter over scores the threads already carry, so it is instant.

export const IMPORTANT = "important";

/** What Important starts with. A person's edit replaces it whole. */
export const DEFAULT_IMPORTANCE_POLICY = `Important to me:
- A real person writing to me, not a company's system: someone I know, someone answering something I sent, or someone with a specific request of me.
- Anything that needs my signature, decision or reply.
- Something already going wrong that will cost me money, access or data unless I act soon: a failed or paused payment, a service shut off, a leaked password or key.

Not important, even when it says "action required":
- Automated mail: alerts and error reports, build and deploy results, sign-in notices and codes, reminders, digests, receipts, confirmations, statements and status updates.
- Notifications from apps I use (chat, task tools, marketplaces, social and neighborhood sites) that point me elsewhere to read the actual message.
- Calendar invitations and updates; my calendar has them.
- Newsletters, marketing, promotions, product news and event invitations from companies.
- Sales pitches and cold outreach from people or companies I have never dealt with.`;

export const MAX_LENS_POLICY = 4000;
export const MAX_LENS_NAME = 32;
/** Tabs past this stop being a glance. */
export const MAX_LENSES = 7;
export const DEFAULT_CUTOFF = 50;
export const MIN_CUTOFF = 5;
export const MAX_CUTOFF = 95;

/** One lens as the person's prefs hold it. `revision` moves on every
 *  description change, so a score judged under an older one is stale. */
export type Lens = {
  id: string;
  name: string;
  /** Absent on Important: the default policy. */
  policy?: string;
  cutoff: number;
  revision: number;
};

/** A thread's lens fields, as both the server row and the client carry. */
export type LensFields = {
  lens_scores?: Record<string, number>;
  lens_why?: Record<string, string>;
  lens_marks?: Record<string, boolean>;
};

const DEFAULT_IMPORTANT: Lens = { id: IMPORTANT, name: "Important", cutoff: DEFAULT_CUTOFF, revision: 0 };
export const DEFAULT_LENSES: readonly Lens[] = Object.freeze([DEFAULT_IMPORTANT]);

/** The lenses a prefs bag describes, Important first and always present.
 *  `importance` is the earlier pref (Important's policy alone), read until
 *  the first lens save replaces it. */
export function lensesFromPrefs(prefs: { lenses?: unknown; importance?: { policy?: string; revision?: number } } | undefined): Lens[] {
  const raw = Array.isArray(prefs?.lenses) ? (prefs!.lenses as Partial<Lens>[]) : [];
  const out: Lens[] = [];
  const seen = new Set<string>();
  for (const l of raw) {
    if (!l || typeof l.id !== "string" || !l.id || seen.has(l.id)) continue;
    seen.add(l.id);
    out.push({
      id: l.id,
      name: typeof l.name === "string" && l.name.trim() ? l.name.trim().slice(0, MAX_LENS_NAME) : l.id === IMPORTANT ? "Important" : "View",
      policy: typeof l.policy === "string" && l.policy.trim() ? l.policy : undefined,
      cutoff: clampCutoff(l.cutoff),
      revision: typeof l.revision === "number" ? l.revision : 0,
    });
  }
  if (!seen.has(IMPORTANT)) {
    const legacy = prefs?.importance;
    out.unshift({
      ...DEFAULT_IMPORTANT,
      policy: legacy?.policy?.trim() ? legacy.policy : undefined,
      revision: typeof legacy?.revision === "number" ? legacy.revision : 0,
    });
  } else if (out[0].id !== IMPORTANT) {
    out.unshift(...out.splice(out.findIndex((l) => l.id === IMPORTANT), 1));
  }
  return out.slice(0, MAX_LENSES);
}

export function clampCutoff(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_CUTOFF;
  return Math.min(MAX_CUTOFF, Math.max(MIN_CUTOFF, n));
}

/** The description the model reads. */
export function lensPolicy(lens: Pick<Lens, "id" | "policy">): string {
  return lens.policy?.trim() || (lens.id === IMPORTANT ? DEFAULT_IMPORTANCE_POLICY : "");
}

/** A thread's place in a lens. A hand mark is final. With no score yet,
 *  Important takes the thread (nothing is hidden before the model has read
 *  it) and every other lens leaves it out (nothing says it belongs). */
export function inLens(t: LensFields, lens: Pick<Lens, "id" | "cutoff">): boolean {
  const mark = t.lens_marks?.[lens.id];
  if (mark !== undefined) return mark;
  const score = t.lens_scores?.[lens.id];
  if (score === undefined) return lens.id === IMPORTANT;
  return score >= lens.cutoff;
}

/** Whether the model has read a thread for a lens (or the person marked it). */
export function lensJudged(t: LensFields, lensId: string): boolean {
  return t.lens_marks?.[lensId] !== undefined || t.lens_scores?.[lensId] !== undefined;
}

export function newLensId(): string {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

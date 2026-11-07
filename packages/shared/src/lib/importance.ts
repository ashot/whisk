// Importance: which inbox mail the person sees first. One plain-language
// policy (theirs to edit) decides it; the server's model reads the policy
// and lands a verdict on each thread. The inbox shows everything not judged
// unimportant, so mail the model has not read yet is never hidden.

/** What a person starts with. Their edits replace it whole. */
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

export const MAX_IMPORTANCE_POLICY = 4000;

/** The client pref under `importance`: the policy text and a counter that
 *  moves on every save, so a verdict judged under an older policy is known
 *  to be stale. */
export type ImportancePrefs = { policy?: string; revision?: number };

export function importancePolicy(prefs: ImportancePrefs | undefined): string {
  const text = prefs?.policy?.trim();
  return text ? text : DEFAULT_IMPORTANCE_POLICY;
}

export function importanceRevision(prefs: ImportancePrefs | undefined): number {
  return typeof prefs?.revision === "number" ? prefs.revision : 0;
}

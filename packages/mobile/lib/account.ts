import type { Account, Label, Thread } from "@mail/shared/src/store/types";
import { orderedAccounts, visibleThreads } from "@mail/shared/src/store/selectors";

/** The account mail is presented "as" when one identity is needed (welcome
 *  gating, compose default): the first in stable order. */
export function primaryAccount(s: any): Account | null {
  const all = orderedAccounts(s.accounts ?? {}) as Account[];
  return all[0] ?? null;
}

export function allAccounts(s: any): Account[] {
  return orderedAccounts(s.accounts ?? {}) as Account[];
}

export function visibleThreadsFor(s: any, view: string): Thread[] {
  return visibleThreads(s.threads, view as any, s.searchHits, s.accountScope, s.reminders, s.labels);
}

/** Label chips for a thread. Label ids repeat across mailboxes, so a chip
 *  resolves within the thread's own account. */
export function chipsFor(s: any, thread: Thread): Label[] {
  const labels = Object.values(s.labels ?? {}) as Label[];
  return thread.label_ids
    .map((id) =>
      labels.find(
        (l) =>
          l.kind === "user" &&
          l.gmail_id === id &&
          (l as any).account_id === (thread as any).account_id,
      ),
    )
    .filter(Boolean) as Label[];
}

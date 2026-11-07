import type { Address, Message } from "../store/types";

// Which address mail leaves from. Gmail lets one mailbox send as several
// verified addresses ("send mail as"), one of them the default. One resolver
// for every surface (the optimistic send, the server's send, compose, the
// CLI) so they never disagree about the From line.

/** One verified address a mailbox may send as, as Gmail reports it. */
export type SendAs = { email: string; name?: string; is_default?: boolean };

export type Sender = { email: string; name?: string; send_as?: readonly SendAs[] };

/** Every address the account can send as, Gmail's default first. An account
 *  whose aliases were never read sends as itself. An address with no display
 *  name of its own goes out under the account's, as Gmail does. */
export function sendAddresses(account: Sender): Address[] {
  const list = account.send_as?.length
    ? [...account.send_as].sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default))
    : [{ email: account.email }];
  return list.map((a) => {
    const name = a.name || account.name;
    return name ? { name, email: a.email } : { email: a.email };
  });
}

/** The From for a send: the chosen address if the account may send as it,
 *  else Gmail's default. */
export function fromAddress(account: Sender, chosen?: string): Address {
  const all = sendAddresses(account);
  const want = chosen?.toLowerCase();
  return all.find((a) => a.email.toLowerCase() === want) ?? all[0];
}

/** Whether an address is one of the account's own. */
export function isOwnAddress(account: Sender, email: string): boolean {
  const e = email.toLowerCase();
  return e === account.email.toLowerCase() || sendAddresses(account).some((a) => a.email.toLowerCase() === e);
}

/** Which of my addresses the answered message involves, so the answer goes
 *  out from it, as Gmail does: the one I sent it from, else the one it was
 *  sent to. Absent when neither (a list, a bcc): the default. */
export function answeredAs(account: Sender, answered: Message | undefined): string | undefined {
  if (!answered) return undefined;
  const mine = [answered.from, ...answered.to, ...(answered.cc ?? [])].find((a) => isOwnAddress(account, a.email));
  return mine && fromAddress(account, mine.email).email;
}

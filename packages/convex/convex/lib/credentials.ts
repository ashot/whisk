import { decryptAESGCMString, encryptAESGCMString } from "@platform/crypto/aes";
import { Doc, Id } from "../_generated/dataModel";

// Gmail access and refresh tokens are sealed at rest. A database read (a
// backup, an export, a dashboard) yields ciphertext; only code running with
// the deployment's WHISK_CREDENTIALS_KEY (32 random bytes, base64) can open
// it. AES-GCM authenticates as well as encrypts, so a tampered value fails to
// open instead of decrypting to garbage.
//
// A sealed value is also bound to where it lives. The account it belongs to
// and the field it sits in are sealed in front of the token, and opening
// checks them against the row being read. GCM authenticates the whole
// plaintext, so that line cannot be altered without the key, and a refresh
// token copied from one person's credentials row into another's (by anyone
// with database write access but not the key) will not open there: it cannot
// point one account at another person's mailbox.
//
// Formats, newest first:
//   enc2:<base64>  bound to account and field. Everything is written this way,
//                  and it is the only form the read path opens.
//   enc1:<base64>  sealed but unbound (the first sealing release).
//   anything else  a row from before sealing, in the clear.
// The two older forms open only inside migrations.sealCredentials, which
// rewrites them as enc2 (`resealLegacyCredential`). Every deployment has been
// migrated, so on the read path an older form is refused: an unbound value
// from an old backup pasted into a row must not open as that row's token.

export const CREDENTIALS_KEY_ENV = "WHISK_CREDENTIALS_KEY";
const SEAL_PREFIX = "enc2:";
const UNBOUND_PREFIX = "enc1:";

export type CredentialField = "access_token" | "refresh_token";

function credentialsKey(): string {
  const key = process.env[CREDENTIALS_KEY_ENV];
  // Fail closed: a deployment without the key must not quietly go back to
  // storing tokens in the clear.
  if (!key) throw new Error(`Credential sealing is not configured (${CREDENTIALS_KEY_ENV})`);
  return key;
}

/** The line a value is sealed behind: its account and field. */
function binding(accountId: Id<"accounts">, field: CredentialField): string {
  return `whisk.credentials:${accountId}:${field}\n`;
}

/** True when a stored value is in the current, bound form. */
export function isSealed(value: string): boolean {
  return value.startsWith(SEAL_PREFIX);
}

function wontOpen(): Error {
  return new Error(`A stored credential would not open (${CREDENTIALS_KEY_ENV} changed?): reconnect the mailbox`);
}

/**
 * Seal a token for one account's field. `value` is a token fresh from Google,
 * or one already sealed in the current form read back from that same field
 * (kept as it is). An older stored form is refused rather than sealed as if
 * it were a token: migrations.sealCredentials is the one way to rewrite it.
 */
export async function sealCredential(
  value: string,
  accountId: Id<"accounts">,
  field: CredentialField,
): Promise<string> {
  if (isSealed(value)) return value;
  if (value.startsWith(UNBOUND_PREFIX)) throw wontOpen();
  return SEAL_PREFIX + (await encryptAESGCMString(binding(accountId, field) + value, credentialsKey()));
}

/** Open a stored token. Throws when it will not open: the key changed, the
 *  value was tampered with, it was sealed for another account or field, or it
 *  is in an older form the read path no longer accepts. */
export async function openCredential(
  stored: string,
  accountId: Id<"accounts">,
  field: CredentialField,
): Promise<string> {
  if (!isSealed(stored)) throw wontOpen();
  const opened = await decryptAESGCMString(stored.slice(SEAL_PREFIX.length), credentialsKey());
  const bound = binding(accountId, field);
  if (opened === null || !opened.startsWith(bound)) throw wontOpen();
  return opened.slice(bound.length);
}

/**
 * Migration only (migrations.sealCredentials): bring a stored value in any
 * form to the current one. An older form is opened as it was written (enc1
 * unbound, or in the clear) and sealed bound to this account and field.
 */
export async function resealLegacyCredential(
  stored: string,
  accountId: Id<"accounts">,
  field: CredentialField,
): Promise<string> {
  if (isSealed(stored)) return stored;
  let plain: string | null = stored;
  if (stored.startsWith(UNBOUND_PREFIX)) {
    plain = await decryptAESGCMString(stored.slice(UNBOUND_PREFIX.length), credentialsKey());
  }
  if (plain === null) throw wontOpen();
  return await sealCredential(plain, accountId, field);
}

type TokenPair = Pick<Doc<"credentials">, "access_token" | "refresh_token">;

export async function sealTokens(accountId: Id<"accounts">, pair: TokenPair): Promise<TokenPair> {
  return {
    access_token: await sealCredential(pair.access_token, accountId, "access_token"),
    refresh_token: await sealCredential(pair.refresh_token, accountId, "refresh_token"),
  };
}

export async function openTokens(accountId: Id<"accounts">, pair: TokenPair): Promise<TokenPair> {
  return {
    access_token: await openCredential(pair.access_token, accountId, "access_token"),
    refresh_token: await openCredential(pair.refresh_token, accountId, "refresh_token"),
  };
}

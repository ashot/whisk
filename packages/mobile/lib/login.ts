import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";

// The login token lives in the iOS keychain. iOS launches the app with the
// phone locked (prewarming, a relaunch after a background kill), and a
// keychain read then fails rather than answering. Two rules keep that from
// signing the person out:
//
//  1. The item is readable after the first unlock since boot, not only while
//     the phone is unlocked. The keychain keeps an item's accessibility from
//     when it was added (a later write updates only the value), so the token
//     moves to a new key written with the new class.
//  2. A failed read is "not yet", never "no login". The read is retried once
//     the app is in front, which also covers a launch before the first unlock.

const KEY = "mail.token.v2";
const LEGACY_KEY = "mail.token";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/** The stored token, or null when there is none. Throws when the keychain
 *  cannot be read right now. */
export async function readLogin(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(KEY, OPTIONS);
  if (token) return token;
  const legacy = await SecureStore.getItemAsync(LEGACY_KEY);
  if (!legacy) return null;
  // Write the new item before dropping the old one, so a kill between the two
  // still leaves a login to find.
  await SecureStore.setItemAsync(KEY, legacy, OPTIONS);
  await SecureStore.deleteItemAsync(LEGACY_KEY).catch(() => {});
  return legacy;
}

export async function saveLogin(token: string | null): Promise<void> {
  if (token) {
    await SecureStore.setItemAsync(KEY, token, OPTIONS);
    return;
  }
  await Promise.all([
    SecureStore.deleteItemAsync(KEY, OPTIONS),
    SecureStore.deleteItemAsync(LEGACY_KEY),
  ]);
}

function nextActive(): Promise<void> {
  return new Promise((resolve) => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      sub.remove();
      resolve();
    });
  });
}

/** The login to boot with. A read that fails in the background waits for the
 *  app to come to the front and tries again; only a read that fails there too
 *  boots signed out. */
export async function restoreLogin(): Promise<string | null> {
  try {
    return await readLogin();
  } catch (e) {
    console.warn("[login] keychain unreadable, retrying when active", e);
    if (AppState.currentState !== "active") await nextActive();
    try {
      return await readLogin();
    } catch {
      return null;
    }
  }
}

// iOS can launch the app with the phone locked. The stored login must survive
// that: a locked keychain is "not yet", never "signed out".
import { beforeEach, expect, mock, test } from "bun:test";

const AFTER_FIRST_UNLOCK = 0;
const WHEN_UNLOCKED = 5;

type Item = { value: string; accessible: number };
const keychain = new Map<string, Item>();
let locked = false;
const read = (key: string) => {
  if (locked) throw new Error("User interaction is not allowed.");
  return keychain.get(key)?.value ?? null;
};
mock.module("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK,
  WHEN_UNLOCKED,
  getItemAsync: async (key: string) => read(key),
  setItemAsync: async (key: string, value: string, opts?: { keychainAccessible?: number }) => {
    if (locked) throw new Error("User interaction is not allowed.");
    // Like the real keychain: an existing item keeps its accessibility.
    const accessible = keychain.get(key)?.accessible ?? opts?.keychainAccessible ?? WHEN_UNLOCKED;
    keychain.set(key, { value, accessible });
  },
  deleteItemAsync: async (key: string) => void keychain.delete(key),
}));

const listeners = new Set<(s: string) => void>();
const appState = { currentState: "active" as string };
mock.module("react-native", () => ({
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_: string, fn: (s: string) => void) => {
      listeners.add(fn);
      return { remove: () => listeners.delete(fn) };
    },
  },
}));
const becomeActive = () => {
  appState.currentState = "active";
  for (const fn of [...listeners]) fn("active");
};

const { readLogin, restoreLogin, saveLogin } = await import("./login");
const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  keychain.clear();
  listeners.clear();
  locked = false;
  appState.currentState = "active";
});

test("a login saved by an older build moves to a key readable after the first unlock", async () => {
  keychain.set("mail.token", { value: "tok", accessible: WHEN_UNLOCKED });
  expect(await readLogin()).toBe("tok");
  expect(keychain.get("mail.token.v2")).toEqual({ value: "tok", accessible: AFTER_FIRST_UNLOCK });
  expect(keychain.has("mail.token")).toBe(false);
});

test("a launch with the keychain locked waits for the app to be in front instead of booting signed out", async () => {
  await saveLogin("tok");
  locked = true;
  appState.currentState = "background";
  let restored: string | null | undefined;
  void restoreLogin().then((t) => (restored = t));
  await settle();
  expect(restored).toBeUndefined();
  locked = false;
  becomeActive();
  await settle();
  expect(restored).toBe("tok");
});

test("a fresh install boots signed out", async () => {
  expect(await restoreLogin()).toBeNull();
});

test("signing out removes the login under both keys", async () => {
  keychain.set("mail.token", { value: "old", accessible: WHEN_UNLOCKED });
  await saveLogin("tok");
  await saveLogin(null);
  expect(await readLogin()).toBeNull();
});

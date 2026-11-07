import Storage from "expo-sqlite/kv-store";
import type { KVStore } from "@mail/platform";

// SQLite-backed KV for the platform's persistence cache. expo-sqlite's
// kv-store has no per-item size ceiling (unlike AsyncStorage on Android), so
// whole-collection JSON blobs are safe here.
export const sqliteKV: KVStore = {
  getItem: (key) => Storage.getItem(key),
  setItem: (key, value) => Storage.setItem(key, value),
  removeItem: (key) => Storage.removeItem(key),
};

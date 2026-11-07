import { useAuthToken } from "@convex-dev/auth/react";
import { createDurableAuthStorage, createLocalAuth } from "@platform/auth/web";

// Convex Auth's client state for whisk, namespaced "mail". The durable
// storage dual-writes localStorage and IndexedDB so a login survives storage
// pressure; the local auth signal is what rendering gates on (the server
// round trip is only for authed side effects).

export const localAuth = createLocalAuth("mail");

export const durableAuth = createDurableAuthStorage({ dbName: "mail-auth" });

/**
 * Local-first "signed in" signal. Same rule as the platform package's
 * useLocalAuth, re-derived here over THIS bundle's @convex-dev/auth react
 * context — the platform copy resolves its own instance of that module in
 * bun's isolated store, and a context read across instances is always null.
 */
export function useLocalAuth(): boolean {
  const token = useAuthToken();
  return token !== null || localAuth.hasStoredAuthToken();
}

/** Synchronous peek at the stored JWT, for URLs that must carry a credential
 *  (attachment streaming, where an <img> cannot send headers). */
export function storedAuthJwt(): string | null {
  try {
    return localStorage.getItem(localAuth.jwtKey);
  } catch {
    return null;
  }
}

// A request the app was opened with (`whisk auth`'s ?cli=1, another app's
// /connect) has to survive a Google sign-in, whose redirect drops the URL.
// It is read from the URL on first landing and kept in sessionStorage (this
// tab only) until it is served or dismissed. The URL is cleaned at once so
// the request never lingers in history or confuses the hash router.

export type StashedRequest<T> = {
  /** The pending request: from the URL on first landing, else the stash. */
  read: () => T | null;
  clear: () => void;
};

export function stashedRequest<T>(
  storageKey: string,
  parse: (location: Location) => T | null,
  /** The path to leave in the address bar once the request is taken. */
  cleanPath: (location: Location) => string = (l) => l.pathname,
): StashedRequest<T> {
  return {
    read() {
      const fresh = parse(window.location);
      if (fresh) {
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(fresh));
        } catch {}
        history.replaceState(null, "", cleanPath(window.location) + window.location.hash);
        return fresh;
      }
      try {
        const raw = sessionStorage.getItem(storageKey);
        return raw ? (JSON.parse(raw) as T) : null;
      } catch {
        return null;
      }
    },
    clear() {
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
    },
  };
}

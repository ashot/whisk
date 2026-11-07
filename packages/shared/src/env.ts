// The one seam where shared client logic touches the host platform. Web works
// with the defaults (localStorage, Web Crypto); native injects its own at boot
// (keychain-backed token storage, expo-crypto uuid) before rendering.

export type PlatformEnv = {
  /** Persist / clear the session token (fire-and-forget). */
  saveToken: (token: string | null) => void;
  /** A v4 uuid for client-minted ids. */
  uuid: () => string;
};

let env: PlatformEnv = {
  saveToken: (token) => {
    try {
      if (token) localStorage.setItem("mail:token", token);
      else localStorage.removeItem("mail:token");
    } catch {}
  },
  uuid: () => {
    try {
      return crypto.randomUUID();
    } catch {
      // Not cryptographic — client ids only need uniqueness.
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
  },
};

export function setPlatformEnv(next: Partial<PlatformEnv>): void {
  env = { ...env, ...next };
}

export function platformEnv(): PlatformEnv {
  return env;
}

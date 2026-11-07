import { api } from "@mail/convex/convex/_generated/api";
import { convexClient } from "./ConvexSync";
import { mailStore } from "../store/mailStore";
import { stashedRequest } from "./stashedRequest";

// Connecting a terminal: `whisk auth` opens the app with ?cli=1&nonce&port
// &device, the signed-in person authorizes, and the app mints a device login
// and hands it to the CLI's localhost listener. The request survives the
// Google sign-in redirect (which drops the query string) through the stash
// in stashedRequest.ts, and is forgotten the moment it is served or dismissed.

export type CliConnectRequest = {
  nonce: string;
  /** Absent when the terminal cannot be reached: the person pastes the token. */
  port: number | null;
  device: string;
};

function fromSearch(search: string): CliConnectRequest | null {
  const params = new URLSearchParams(search);
  if (params.get("cli") !== "1") return null;
  const nonce = params.get("nonce") ?? "";
  if (!nonce) return null;
  const port = Number(params.get("port"));
  return {
    nonce,
    port: Number.isInteger(port) && port > 0 ? port : null,
    device: params.get("device") || "a terminal",
  };
}

const pending = stashedRequest("mail:cli-connect", (l) => fromSearch(l.search));

/** The pending request, if any: from the URL on first landing (stashed so a
 *  sign-in round trip keeps it), else from the stash. */
export const cliConnectRequest = (): CliConnectRequest | null => pending.read();

export const clearCliConnect = (): void => pending.clear();

export type MintedDevice = { token: string; user_id: string; email: string | null };

/** Mint a device login for this person. A legacy-token session presents its
 *  token; a Convex Auth session resolves from the JWT on the socket. */
export function mintDeviceToken(deviceName: string, opts: { agent?: boolean } = {}): Promise<MintedDevice> {
  return convexClient().mutation(api.devices.mint, {
    token: mailStore.getState().authToken ?? undefined,
    device_name: deviceName,
    // An agent login never sees private mail and cannot change what is.
    hides_private: opts.agent || undefined,
  });
}

/**
 * Hand the token to the CLI waiting on 127.0.0.1. Returns false when nothing
 * answered (the terminal is on another machine, or gave up); throws when it
 * answered but refused, which means a stale run still holds the port.
 */
export async function deliverToCli(
  request: CliConnectRequest,
  minted: MintedDevice,
): Promise<boolean> {
  if (!request.port) return false;
  let response: Response;
  try {
    // 127.0.0.1, not localhost: the listener binds IPv4 only, and Safari
    // does not fall back from a refused ::1.
    response = await fetch(`http://127.0.0.1:${request.port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nonce: request.nonce,
        userId: minted.user_id,
        apiToken: minted.token,
      }),
    });
  } catch {
    return false;
  }
  if (!response.ok) {
    throw new Error(
      "The terminal refused this sign-in. It may be left over from an earlier `whisk auth` run.",
    );
  }
  return true;
}

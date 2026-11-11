// A message's full header list lives only in Gmail; the sync keeps the
// address headers. Same seam as searchBridge: the sync layer wires the real
// action in, the screen calls through, and neither imports the other.

import { useState } from "react";

export type MessageHeader = { name: string; value: string };

type FetchHeaders = (messageGmailId: string) => Promise<MessageHeader[]>;

let handler: FetchHeaders | null = null;

export function setHeadersFetcher(fn: FetchHeaders | null): void {
  handler = fn;
}

/** Every header on the message, as Gmail holds it. Throws when offline or
 *  when no sync layer is wired. */
export async function fetchMessageHeaders(messageGmailId: string): Promise<MessageHeader[]> {
  if (!handler) throw new Error("Headers are not available in this session");
  return await handler(messageGmailId);
}

/** Fetched header lists, kept for the session: a message's headers never change. */
const cache = new Map<string, MessageHeader[]>();

export type HeadersState =
  | { status: "closed" | "loading" }
  | { status: "open"; headers: MessageHeader[] }
  | { status: "error" };

/** The open/closed state of one message's full header list, fetched on the
 *  first open and served from the session cache after that. */
export function useMessageHeaders(messageGmailId: string): [HeadersState, () => void] {
  const [state, setState] = useState<HeadersState>({ status: "closed" });
  const toggle = () => {
    if (state.status === "open" || state.status === "loading") return setState({ status: "closed" });
    const cached = cache.get(messageGmailId);
    if (cached) return setState({ status: "open", headers: cached });
    setState({ status: "loading" });
    fetchMessageHeaders(messageGmailId).then(
      (headers) => {
        cache.set(messageGmailId, headers);
        setState((s) => (s.status === "loading" ? { status: "open", headers } : s));
      },
      () => setState((s) => (s.status === "loading" ? { status: "error" } : s)),
    );
  };
  return [state, toggle];
}

/** The header block as the message carries it, one "Name: value" per line. */
export function headersText(headers: MessageHeader[]): string {
  return headers.map((h) => `${h.name}: ${h.value}`).join("\n");
}

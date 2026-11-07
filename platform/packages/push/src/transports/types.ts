// The delivery seam. The policy decides what to say; a transport says it.
//
// Both shipped transports are best effort by design: a push that fails is
// logged and dropped, never retried. A retried push arrives late, and a late
// push is worse than none — the state it described has already moved on.

/** What one push says, independent of who carries it. */
export interface PushMessage {
  title: string;
  /** Second line on iOS. Android folds it into the title. */
  subtitle?: string;
  body: string;
  data?: unknown;
  /** App icon badge. Keep it equal to the app's own unread count. */
  badge?: number;
  /** Bundled sound file name, or "default". */
  sound?: string;
  /** Android notification channel. */
  channelId?: string;
  /** iOS: "time-sensitive" for anything addressed to the person. */
  interruptionLevel?: string;
  /** iOS actionable notification category the app registered. */
  categoryId?: string;
  /** Drop the push if it cannot be delivered inside this many seconds. */
  ttlSeconds?: number;
  priority?: "default" | "high";
  /** iOS: wake the app in the background so it can act on the push before
   *  the person taps it (`content-available`). Apple budgets these, so set
   *  it only on pushes the app has work to do for. */
  contentAvailable?: boolean;
}

/** One device to deliver to. */
export interface PushTarget {
  token: string;
  platform?: "ios" | "android" | (string & {});
  /** Which transport owns this token. Defaults to the router's default. */
  transport?: string;
}

export interface DeliveryResult {
  /** Tokens the service accepted. */
  sent: number;
  /** Duplicate tokens the transport folded away before sending. */
  deduped: number;
  /** Tokens the service says are dead. Clear them from the recipient. */
  deadTokens: string[];
  /** Failures, already logged. Present for tests and metrics, not retries. */
  errors: string[];
}

export interface PushTransport {
  readonly name: string;
  send(targets: PushTarget[], message: PushMessage): Promise<DeliveryResult>;
}

/** Injectable fetch, so tests and exotic runtimes never touch the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Injectable logging, so a failure is visible without a console dependency. */
export interface Logger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export const consoleLogger: Logger = {
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

export function emptyResult(): DeliveryResult {
  return { sent: 0, deduped: 0, deadTokens: [], errors: [] };
}

/**
 * One entry per token, first occurrence wins. Several devices signed into one
 * account regularly report the same token; sending twice buzzes twice.
 */
export function dedupeTargets(targets: PushTarget[]): {
  unique: PushTarget[];
  deduped: number;
} {
  const seen = new Set<string>();
  const unique: PushTarget[] = [];
  for (const t of targets) {
    if (!t.token || seen.has(t.token)) continue;
    seen.add(t.token);
    unique.push(t);
  }
  return { unique, deduped: targets.length - unique.length };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

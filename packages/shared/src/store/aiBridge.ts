// The store owns the AI gestures; the sync layer owns the network. Same seam
// as searchBridge: ConvexSync wires the real actions in, the store calls
// through, and neither imports the other.

export type AiClient = {
  draftReply: (input: {
    threadGmailId: string;
    accountId?: string;
    instruction?: string;
  }) => Promise<{ body_text: string }>;
  summarizeThread: (input: {
    threadGmailId: string;
    accountId?: string;
    /** Give up after this long (a notification waiting on it). */
    timeoutMs?: number;
    /** Only the newest message, as a notification announces it. */
    latest?: boolean;
  }) => Promise<{ summary: string }>;
  /** Predicted replies for the empty composer, from sent-mail voice. */
  suggestReplies: (input: {
    threadGmailId: string;
    accountId?: string;
  }) => Promise<{ suggestions: string[]; anchor: string | null }>;
  /** Read a sentence as a filter: a condition and constrained actions. */
  parseFilter: (input: {
    text: string;
    accountId?: string;
  }) => Promise<{ condition: string; actions: Array<{ kind: string; arg?: string }> }>;
  /** Dry run: the inbox thread ids a condition matches right now. */
  previewFilter: (input: { condition: string; accountId?: string; limit?: number }) => Promise<string[]>;
  /** Dry run: every recent inbox thread's score on a draft lens. */
  previewLens: (input: { name: string; policy: string; accountId?: string; limit?: number }) => Promise<Array<{ thread_gmail_id: string; score: number; why: string }>>;
  /** Dry run: the recent threads a privacy rule would make private, and why. */
  previewPrivacy: (input: { text: string; limit?: number }) => Promise<Array<{ account_id: string; thread_gmail_id: string; subject: string; from: string; why: string }>>;
};

let client: AiClient | null = null;

export function setAiClient(c: AiClient | null): void {
  client = c;
}

export function aiClient(): AiClient {
  if (!client) throw new Error("AI is not available in this session");
  return client;
}

export function aiAvailable(): boolean {
  return client !== null;
}

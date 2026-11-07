"use node";

import Anthropic from "@anthropic-ai/sdk";

// The one place model names and the Anthropic client live. Two tiers, chosen
// per task by latency: classification and summaries must feel instant
// (Haiku); drafting in the owner's voice is worth seconds (Opus).

export const FAST_MODEL = "claude-haiku-4-5";
export const SMART_MODEL = "claude-opus-5";
/** Lens scoring runs on every new email, so it must be cheap and quick, but
 *  Haiku reads any machine mail that says "action required" as important
 *  (scripts/lens-eval.ts: 19% precision on Haiku 4.5, ~50% on Haiku 5.5,
 *  90-100% on Sonnet 5.5 at low effort, same recall). */
export const LENS_MODEL = "claude-sonnet-5-5";
/** The privacy judge reads every thread with new mail once rules exist, and
 *  a miss shows private mail to an agent, so it needs Sonnet's care at
 *  Haiku-like cost: low effort, small batches. */
export const PRIVACY_MODEL = "claude-sonnet-5-5";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "AI is not configured on this deployment (ANTHROPIC_API_KEY missing)",
    );
  }
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

export function aiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export type Effort = "low" | "medium" | "high";

/** One text-in, text-out completion. `effort` bounds how long the model
 *  thinks — low for judging and matching, medium for organizing, the default
 *  (high) for writing. */
export async function complete(input: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  effort?: Effort;
  timeoutMs?: number;
}): Promise<string> {
  const response = await anthropic().messages.create({
    model: input.model,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: [{ role: "user", content: input.user }],
    ...(input.effort ? { output_config: { effort: input.effort } } : {}),
  }, input.timeoutMs ? { timeout: input.timeoutMs, maxRetries: 0 } : undefined);
  let out = "";
  for (const block of response.content) {
    if (block.type === "text") out += block.text;
  }
  return out.trim();
}

/**
 * A completion that must come back as JSON. Strips a markdown fence if the
 * model added one; returns null on anything unparseable so callers degrade
 * quietly instead of failing a sync.
 */
export async function completeJson<T>(input: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  effort?: Effort;
  timeoutMs?: number;
}): Promise<T | null> {
  return parseJsonReply<T>(await complete(input));
}

/** The JSON inside a model reply: a markdown fence or prose around the
 *  object is tolerated; anything unparseable is null. */
export function parseJsonReply<T>(raw: string): T | null {
  // Tolerate prose around the object: take the outermost braces/brackets.
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.search(/[[{]/);
  const end = Math.max(unfenced.lastIndexOf("}"), unfenced.lastIndexOf("]"));
  const body = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

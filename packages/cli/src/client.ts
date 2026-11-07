import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference, FunctionArgs, FunctionReturnType } from "convex/server";
import { settings } from "./config";
import { fmt } from "./colors";

// One HTTP client per process. Every call carries the device token: the
// backend resolves it to the person's whole account roster, so the CLI talks
// to exactly the functions the web app does, with no separate API.

let client: ConvexHttpClient | null = null;

export function convex(): ConvexHttpClient {
  if (!client) client = new ConvexHttpClient(settings().convexUrl);
  return client;
}

export class NotAuthed extends Error {}

export function requireToken(): string {
  const token = settings().token;
  if (!token) {
    throw new NotAuthed(
      `Not signed in. Run ${fmt.cmd("whisk auth")} (browser) or ${fmt.cmd("whisk login <token>")}.`,
    );
  }
  return token;
}

type WithToken<A> = Omit<A, "token">;

export function query<Q extends FunctionReference<"query">>(
  fn: Q,
  args: WithToken<FunctionArgs<Q>>,
): Promise<FunctionReturnType<Q>> {
  return convex().query(fn, { ...(args as object), token: requireToken() } as FunctionArgs<Q>);
}

export function mutation<M extends FunctionReference<"mutation">>(
  fn: M,
  args: WithToken<FunctionArgs<M>>,
): Promise<FunctionReturnType<M>> {
  return convex().mutation(fn, { ...(args as object), token: requireToken() } as FunctionArgs<M>);
}

export function action<A extends FunctionReference<"action">>(
  fn: A,
  args: WithToken<FunctionArgs<A>>,
): Promise<FunctionReturnType<A>> {
  return convex().action(fn, { ...(args as object), token: requireToken() } as FunctionArgs<A>);
}

/** A server error, with Convex's wrapping stripped down to the message. */
export { serverErrorMessage as errorMessage } from "@mail/shared/src/lib/serverError";

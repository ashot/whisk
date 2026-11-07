import { api } from "@mail/convex/convex/_generated/api";
import { convexClient } from "../sync/ConvexSync";
import { mailStore } from "../store/mailStore";

export function calendarWrite(
  action:
    | "createEvent"
    | "updateEvent"
    | "deleteEvent"
    | "rsvpEvent"
    | "retryCalendarWrites",
  payload: object,
): Promise<unknown> {
  if (!navigator.onLine)
    return Promise.reject(
      new Error(
        "You’re offline. Your changes are still here; reconnect and save again.",
      ),
    );
  const mutation = convexClient().mutation(api.dispatch.dispatch, {
    token: mailStore.getState().authToken ?? undefined,
    action,
    args: [payload],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            "Confirmation is taking longer than expected. Check your calendar before retrying; your draft is still here.",
          ),
        ),
      30_000,
    );
    mutation.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

export function calendarWriteMessage(accountId: string): string {
  return mailStore.getState().accounts[accountId]?.provider === "demo"
    ? "Event saved"
    : "Event queued for Google Calendar";
}

export function calendarError(error: unknown): string {
  return error instanceof Error
    ? error.message
        .replace(/\[CONVEX[^\]]*\]\s*/g, "")
        .replace(/\[Request ID:[^\]]*\]\s*/g, "")
        .replace(/^Server Error\s*/, "")
        .split("\n")[0]
    : "Could not save this event. Please try again.";
}

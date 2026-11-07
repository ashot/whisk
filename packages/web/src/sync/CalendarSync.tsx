import { useEffect } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { api } from "@mail/convex/convex/_generated/api";
import { subscribeDeltaPages } from "@mail/shared/src/store/liveDeltaPages";
import { mailStore, useTracked } from "../store/mailStore";
import { convexClient } from "./ConvexSync";

export function CalendarSync(): null {
  const state = useTracked([(s) => s.authToken]);
  const authenticated = useAuthToken() !== null;
  useEffect(() => {
    const token = state.authToken ?? undefined;
    if (!token && !authenticated) return;
    const client = convexClient();
    let active = true;
    let calendarsReady = false;
    let eventsReady = false;
    const errors = new Set<string>();
    mailStore
      .getState()
      .setCalendarState({ calendarReady: false, calendarSyncError: null });
    const publish = () => {
      if (!active) return;
      mailStore.getState().setCalendarState({
        calendarReady: errors.size > 0 || (calendarsReady && eventsReady),
        calendarSyncError: errors.size
          ? "Calendar couldn’t refresh. Your saved schedule is still available."
          : null,
      });
    };
    const failed = (channel: string) => {
      errors.add(channel);
      publish();
    };
    const subscriptions = [
      client.onUpdate(
        api.calendar.read.listCalendars,
        { token },
        (rows) => {
          if (!active) return;
          mailStore.getState().syncTable("calendars", rows);
          calendarsReady = true;
          errors.delete("calendars");
          publish();
        },
        () => failed("calendars"),
      ),
      subscribeDeltaPages(
        (since, update, failed) =>
          client.onUpdate(
            api.calendar.read.listEvents,
            { token, since },
            update,
            failed,
          ),
        (rows) => mailStore.getState().syncTable("events", rows),
        () => {
          eventsReady = true;
          errors.delete("events");
          publish();
        },
        () => failed("events"),
      ),
    ];
    void client.mutation(api.calendar.demo.ensureDemoCalendars, { token }).then(
      () => {
        errors.delete("demo");
        publish();
      },
      () => failed("demo"),
    );
    return () => {
      active = false;
      subscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, [state.authToken, authenticated]);
  return null;
}

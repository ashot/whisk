// Every way into a thread goes through here: a row in the inbox, a search
// hit, a tapped push. The store learns which thread is open before the screen
// asks, because the screen and the messages subscription both follow the
// store, not the route.
import { router } from "expo-router";
import { mailStore } from "@mail/shared/src/store/mailStore";

export function openThreadScreen(id: string): void {
  mailStore.getState().openThread(id);
  router.push({ pathname: "/thread/[id]", params: { id } });
}

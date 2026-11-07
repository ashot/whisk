// A push that arrives while the app is in the background or killed wakes
// this task (the server marks mail pushes content-available). It fetches the
// mail the push names into the local cache, so the tap that follows opens a
// thread that is already here. Defined at module scope from the app entry:
// expo-task-manager loads the bundle with no app mounted and runs it.
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { backgroundPushData, warm } from "./push";
import { boot, flushCache } from "./sync";

export const BACKGROUND_PUSH_TASK = "whisk-background-push";

/** What the task tells iOS (UIBackgroundFetchResult); the numbers are the
 *  native BackgroundNotificationResult enum, which the package does not
 *  export. */
const Result = { NoData: 1, NewData: 2, Failed: 3 } as const;

export async function runBackgroundPush(payload: Notifications.NotificationTaskPayload): Promise<number> {
  const data = backgroundPushData(payload);
  if (!data.thread_id) return Result.NoData;
  boot();
  await warm(data);
  flushCache();
  return Result.NewData;
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(BACKGROUND_PUSH_TASK, async ({ data, error }) => {
  if (error || !data) return Result.Failed;
  return runBackgroundPush(data);
});

Notifications.registerTaskAsync(BACKGROUND_PUSH_TASK).catch((e) => console.warn("[push] background task not registered", e));

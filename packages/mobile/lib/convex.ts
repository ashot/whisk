import { ConvexClient } from "convex/browser";

// One client for the whole app, same as the web's ConvexSync. EXPO_PUBLIC_*
// vars are inlined at bundle time; the fallbacks point at the dev deployment
// so a fresh checkout runs without any env file.
export const CONVEX_URL: string =
  process.env.EXPO_PUBLIC_CONVEX_URL ?? "https://determined-fox-931.convex.cloud";
export const CONVEX_SITE_URL: string =
  process.env.EXPO_PUBLIC_CONVEX_SITE_URL ?? "https://determined-fox-931.convex.site";

let client: ConvexClient | null = null;
export function convexClient(): ConvexClient {
  if (!client) client = new ConvexClient(CONVEX_URL);
  return client;
}

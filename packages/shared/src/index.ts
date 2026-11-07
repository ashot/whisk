// @mail/shared — the mail app's client logic, platform-free. The store, its
// selectors and formatting run identically on web (DOM) and native; anything
// platform-shaped goes through env.ts.

export * from "./store/types";
// selectors also names a `Cluster` (a sweep pile); the row type wins the bare name.
export * from "./store/selectors";
export * from "./store/searchBridge";
export * from "./store/registry";
export * from "./store/mailStore";
export * from "./store/deltaPages";
export * from "./lib/format";
export { setPlatformEnv, platformEnv, type PlatformEnv } from "./env";

/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as ai_actions from "../ai/actions.js";
import type * as ai_classify from "../ai/classify.js";
import type * as ai_draft from "../ai/draft.js";
import type * as ai_filterSupport from "../ai/filterSupport.js";
import type * as ai_grouping from "../ai/grouping.js";
import type * as ai_judge from "../ai/judge.js";
import type * as ai_lenses from "../ai/lenses.js";
import type * as ai_llm from "../ai/llm.js";
import type * as ai_mailText from "../ai/mailText.js";
import type * as ai_profile from "../ai/profile.js";
import type * as ai_suggest from "../ai/suggest.js";
import type * as ai_summarize from "../ai/summarize.js";
import type * as auth from "../auth.js";
import type * as calendar_api from "../calendar/api.js";
import type * as calendar_demo from "../calendar/demo.js";
import type * as calendar_outbound from "../calendar/outbound.js";
import type * as calendar_read from "../calendar/read.js";
import type * as calendar_sync from "../calendar/sync.js";
import type * as calendar_write from "../calendar/write.js";
import type * as clusters from "../clusters.js";
import type * as connect from "../connect.js";
import type * as crons from "../crons.js";
import type * as demo from "../demo.js";
import type * as devices from "../devices.js";
import type * as dispatch from "../dispatch.js";
import type * as filters from "../filters.js";
import type * as gmail_api from "../gmail/api.js";
import type * as gmail_attachments from "../gmail/attachments.js";
import type * as gmail_oauth from "../gmail/oauth.js";
import type * as gmail_pump from "../gmail/pump.js";
import type * as gmail_sync from "../gmail/sync.js";
import type * as gmail_watch from "../gmail/watch.js";
import type * as http from "../http.js";
import type * as lenses from "../lenses.js";
import type * as lib_accounts from "../lib/accounts.js";
import type * as lib_actionAuth from "../lib/actionAuth.js";
import type * as lib_apps from "../lib/apps.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_categorize from "../lib/categorize.js";
import type * as lib_credentials from "../lib/credentials.js";
import type * as lib_drafts from "../lib/drafts.js";
import type * as lib_outbound from "../lib/outbound.js";
import type * as lib_pushPlan from "../lib/pushPlan.js";
import type * as lib_rows from "../lib/rows.js";
import type * as lib_threads from "../lib/threads.js";
import type * as memories from "../memories.js";
import type * as migrations from "../migrations.js";
import type * as push from "../push.js";
import type * as reminders from "../reminders.js";
import type * as search from "../search.js";
import type * as sync from "../sync.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  "ai/actions": typeof ai_actions;
  "ai/classify": typeof ai_classify;
  "ai/draft": typeof ai_draft;
  "ai/filterSupport": typeof ai_filterSupport;
  "ai/grouping": typeof ai_grouping;
  "ai/judge": typeof ai_judge;
  "ai/lenses": typeof ai_lenses;
  "ai/llm": typeof ai_llm;
  "ai/mailText": typeof ai_mailText;
  "ai/profile": typeof ai_profile;
  "ai/suggest": typeof ai_suggest;
  "ai/summarize": typeof ai_summarize;
  auth: typeof auth;
  "calendar/api": typeof calendar_api;
  "calendar/demo": typeof calendar_demo;
  "calendar/outbound": typeof calendar_outbound;
  "calendar/read": typeof calendar_read;
  "calendar/sync": typeof calendar_sync;
  "calendar/write": typeof calendar_write;
  clusters: typeof clusters;
  connect: typeof connect;
  crons: typeof crons;
  demo: typeof demo;
  devices: typeof devices;
  dispatch: typeof dispatch;
  filters: typeof filters;
  "gmail/api": typeof gmail_api;
  "gmail/attachments": typeof gmail_attachments;
  "gmail/oauth": typeof gmail_oauth;
  "gmail/pump": typeof gmail_pump;
  "gmail/sync": typeof gmail_sync;
  "gmail/watch": typeof gmail_watch;
  http: typeof http;
  lenses: typeof lenses;
  "lib/accounts": typeof lib_accounts;
  "lib/actionAuth": typeof lib_actionAuth;
  "lib/apps": typeof lib_apps;
  "lib/auth": typeof lib_auth;
  "lib/categorize": typeof lib_categorize;
  "lib/credentials": typeof lib_credentials;
  "lib/drafts": typeof lib_drafts;
  "lib/outbound": typeof lib_outbound;
  "lib/pushPlan": typeof lib_pushPlan;
  "lib/rows": typeof lib_rows;
  "lib/threads": typeof lib_threads;
  memories: typeof memories;
  migrations: typeof migrations;
  push: typeof push;
  reminders: typeof reminders;
  search: typeof search;
  sync: typeof sync;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

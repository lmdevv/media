/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as core_auth_apiKeys from "../core/auth/apiKeys.js";
import type * as core_auth_caller from "../core/auth/caller.js";
import type * as core_auth_deviceCodes from "../core/auth/deviceCodes.js";
import type * as core_auth_password from "../core/auth/password.js";
import type * as core_auth_sessions from "../core/auth/sessions.js";
import type * as core_auth_sweep from "../core/auth/sweep.js";
import type * as core_lib_counters from "../core/lib/counters.js";
import type * as core_lib_errors from "../core/lib/errors.js";
import type * as core_lib_paginate from "../core/lib/paginate.js";
import type * as core_lib_rateLimit from "../core/lib/rateLimit.js";
import type * as core_lib_secrets from "../core/lib/secrets.js";
import type * as core_lib_usernames from "../core/lib/usernames.js";
import type * as core_limitsProbe from "../core/limitsProbe.js";
import type * as core_server from "../core/server.js";
import type * as core_sessions from "../core/sessions.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  "core/auth/apiKeys": typeof core_auth_apiKeys;
  "core/auth/caller": typeof core_auth_caller;
  "core/auth/deviceCodes": typeof core_auth_deviceCodes;
  "core/auth/password": typeof core_auth_password;
  "core/auth/sessions": typeof core_auth_sessions;
  "core/auth/sweep": typeof core_auth_sweep;
  "core/lib/counters": typeof core_lib_counters;
  "core/lib/errors": typeof core_lib_errors;
  "core/lib/paginate": typeof core_lib_paginate;
  "core/lib/rateLimit": typeof core_lib_rateLimit;
  "core/lib/secrets": typeof core_lib_secrets;
  "core/lib/usernames": typeof core_lib_usernames;
  "core/limitsProbe": typeof core_limitsProbe;
  "core/server": typeof core_server;
  "core/sessions": typeof core_sessions;
  crons: typeof crons;
  http: typeof http;
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

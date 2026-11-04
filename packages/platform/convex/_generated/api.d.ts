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
import type * as core_imports from "../core/imports.js";
import type * as core_jobs_admin from "../core/jobs/admin.js";
import type * as core_jobs_kinds from "../core/jobs/kinds.js";
import type * as core_jobs_leases from "../core/jobs/leases.js";
import type * as core_jobs_machine from "../core/jobs/machine.js";
import type * as core_jobs_model from "../core/jobs/model.js";
import type * as core_jobs_probe from "../core/jobs/probe.js";
import type * as core_jobs_queue from "../core/jobs/queue.js";
import type * as core_jobs_store from "../core/jobs/store.js";
import type * as core_jobs_worker from "../core/jobs/worker.js";
import type * as core_lib_counters from "../core/lib/counters.js";
import type * as core_lib_errors from "../core/lib/errors.js";
import type * as core_lib_paginate from "../core/lib/paginate.js";
import type * as core_lib_rateLimit from "../core/lib/rateLimit.js";
import type * as core_lib_secrets from "../core/lib/secrets.js";
import type * as core_lib_serverFacing from "../core/lib/serverFacing.js";
import type * as core_lib_usernames from "../core/lib/usernames.js";
import type * as core_limitsProbe from "../core/limitsProbe.js";
import type * as core_schemaMigrations from "../core/schemaMigrations.js";
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
  "core/imports": typeof core_imports;
  "core/jobs/admin": typeof core_jobs_admin;
  "core/jobs/kinds": typeof core_jobs_kinds;
  "core/jobs/leases": typeof core_jobs_leases;
  "core/jobs/machine": typeof core_jobs_machine;
  "core/jobs/model": typeof core_jobs_model;
  "core/jobs/probe": typeof core_jobs_probe;
  "core/jobs/queue": typeof core_jobs_queue;
  "core/jobs/store": typeof core_jobs_store;
  "core/jobs/worker": typeof core_jobs_worker;
  "core/lib/counters": typeof core_lib_counters;
  "core/lib/errors": typeof core_lib_errors;
  "core/lib/paginate": typeof core_lib_paginate;
  "core/lib/rateLimit": typeof core_lib_rateLimit;
  "core/lib/secrets": typeof core_lib_secrets;
  "core/lib/serverFacing": typeof core_lib_serverFacing;
  "core/lib/usernames": typeof core_lib_usernames;
  "core/limitsProbe": typeof core_limitsProbe;
  "core/schemaMigrations": typeof core_schemaMigrations;
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

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
import type * as core_accounts_host from "../core/accounts/host.js";
import type * as core_accounts_invites from "../core/accounts/invites.js";
import type * as core_accounts_me from "../core/accounts/me.js";
import type * as core_accounts_resetLinks from "../core/accounts/resetLinks.js";
import type * as core_accounts_users from "../core/accounts/users.js";
import type * as core_auth_apiKeys from "../core/auth/apiKeys.js";
import type * as core_auth_caller from "../core/auth/caller.js";
import type * as core_auth_deviceCodes from "../core/auth/deviceCodes.js";
import type * as core_auth_flows from "../core/auth/flows.js";
import type * as core_auth_password from "../core/auth/password.js";
import type * as core_auth_sessions from "../core/auth/sessions.js";
import type * as core_auth_sweep from "../core/auth/sweep.js";
import type * as core_auth_tiles from "../core/auth/tiles.js";
import type * as core_devices_approvals from "../core/devices/approvals.js";
import type * as core_devices_facts from "../core/devices/facts.js";
import type * as core_devices_picker from "../core/devices/picker.js";
import type * as core_devices_registry from "../core/devices/registry.js";
import type * as core_devices_tiles from "../core/devices/tiles.js";
import type * as core_devices_unlockCodes from "../core/devices/unlockCodes.js";
import type * as core_folders from "../core/folders.js";
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
import type * as core_lib_inOrder from "../core/lib/inOrder.js";
import type * as core_lib_paginate from "../core/lib/paginate.js";
import type * as core_lib_passwords from "../core/lib/passwords.js";
import type * as core_lib_rateLimit from "../core/lib/rateLimit.js";
import type * as core_lib_secrets from "../core/lib/secrets.js";
import type * as core_lib_serverFacing from "../core/lib/serverFacing.js";
import type * as core_lib_usernames from "../core/lib/usernames.js";
import type * as core_libraries from "../core/libraries.js";
import type * as core_libraryProbe from "../core/libraryProbe.js";
import type * as core_limitsProbe from "../core/limitsProbe.js";
import type * as core_permissions_authorize from "../core/permissions/authorize.js";
import type * as core_permissions_grants from "../core/permissions/grants.js";
import type * as core_permissions_groups from "../core/permissions/groups.js";
import type * as core_permissions_policy from "../core/permissions/policy.js";
import type * as core_restrictions from "../core/restrictions.js";
import type * as core_scans from "../core/scans.js";
import type * as core_schemaMigrations from "../core/schemaMigrations.js";
import type * as core_server from "../core/server.js";
import type * as core_sessions from "../core/sessions.js";
import type * as core_settings from "../core/settings.js";
import type * as core_tickets from "../core/tickets.js";
import type * as core_ticketsProbe from "../core/ticketsProbe.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  "core/accounts/host": typeof core_accounts_host;
  "core/accounts/invites": typeof core_accounts_invites;
  "core/accounts/me": typeof core_accounts_me;
  "core/accounts/resetLinks": typeof core_accounts_resetLinks;
  "core/accounts/users": typeof core_accounts_users;
  "core/auth/apiKeys": typeof core_auth_apiKeys;
  "core/auth/caller": typeof core_auth_caller;
  "core/auth/deviceCodes": typeof core_auth_deviceCodes;
  "core/auth/flows": typeof core_auth_flows;
  "core/auth/password": typeof core_auth_password;
  "core/auth/sessions": typeof core_auth_sessions;
  "core/auth/sweep": typeof core_auth_sweep;
  "core/auth/tiles": typeof core_auth_tiles;
  "core/devices/approvals": typeof core_devices_approvals;
  "core/devices/facts": typeof core_devices_facts;
  "core/devices/picker": typeof core_devices_picker;
  "core/devices/registry": typeof core_devices_registry;
  "core/devices/tiles": typeof core_devices_tiles;
  "core/devices/unlockCodes": typeof core_devices_unlockCodes;
  "core/folders": typeof core_folders;
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
  "core/lib/inOrder": typeof core_lib_inOrder;
  "core/lib/paginate": typeof core_lib_paginate;
  "core/lib/passwords": typeof core_lib_passwords;
  "core/lib/rateLimit": typeof core_lib_rateLimit;
  "core/lib/secrets": typeof core_lib_secrets;
  "core/lib/serverFacing": typeof core_lib_serverFacing;
  "core/lib/usernames": typeof core_lib_usernames;
  "core/libraries": typeof core_libraries;
  "core/libraryProbe": typeof core_libraryProbe;
  "core/limitsProbe": typeof core_limitsProbe;
  "core/permissions/authorize": typeof core_permissions_authorize;
  "core/permissions/grants": typeof core_permissions_grants;
  "core/permissions/groups": typeof core_permissions_groups;
  "core/permissions/policy": typeof core_permissions_policy;
  "core/restrictions": typeof core_restrictions;
  "core/scans": typeof core_scans;
  "core/schemaMigrations": typeof core_schemaMigrations;
  "core/server": typeof core_server;
  "core/sessions": typeof core_sessions;
  "core/settings": typeof core_settings;
  "core/tickets": typeof core_tickets;
  "core/ticketsProbe": typeof core_ticketsProbe;
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

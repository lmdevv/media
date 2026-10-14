/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as apiKeys from "../apiKeys.js";
import type * as auth from "../auth.js";
import type * as commands from "../commands.js";
import type * as crons from "../crons.js";
import type * as handlers_admin from "../handlers/admin.js";
import type * as handlers_collection from "../handlers/collection.js";
import type * as handlers_library from "../handlers/library.js";
import type * as handlers_playback from "../handlers/playback.js";
import type * as handlers_types from "../handlers/types.js";
import type * as http from "../http.js";
import type * as lib_catalog from "../lib/catalog.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_devices from "../lib/devices.js";
import type * as lib_env from "../lib/env.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_ids from "../lib/ids.js";
import type * as lib_pages from "../lib/pages.js";
import type * as lib_paths from "../lib/paths.js";
import type * as lib_playback from "../lib/playback.js";
import type * as lib_present from "../lib/present.js";
import type * as lib_queue from "../lib/queue.js";
import type * as lib_sequence from "../lib/sequence.js";
import type * as lib_service from "../lib/service.js";
import type * as lib_sessions from "../lib/sessions.js";
import type * as lib_viewer from "../lib/viewer.js";
import type * as maintenance from "../maintenance.js";
import type * as media from "../media.js";
import type * as migrations from "../migrations.js";
import type * as setup from "../setup.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  apiKeys: typeof apiKeys;
  auth: typeof auth;
  commands: typeof commands;
  crons: typeof crons;
  "handlers/admin": typeof handlers_admin;
  "handlers/collection": typeof handlers_collection;
  "handlers/library": typeof handlers_library;
  "handlers/playback": typeof handlers_playback;
  "handlers/types": typeof handlers_types;
  http: typeof http;
  "lib/catalog": typeof lib_catalog;
  "lib/crypto": typeof lib_crypto;
  "lib/devices": typeof lib_devices;
  "lib/env": typeof lib_env;
  "lib/errors": typeof lib_errors;
  "lib/ids": typeof lib_ids;
  "lib/pages": typeof lib_pages;
  "lib/paths": typeof lib_paths;
  "lib/playback": typeof lib_playback;
  "lib/present": typeof lib_present;
  "lib/queue": typeof lib_queue;
  "lib/sequence": typeof lib_sequence;
  "lib/service": typeof lib_service;
  "lib/sessions": typeof lib_sessions;
  "lib/viewer": typeof lib_viewer;
  maintenance: typeof maintenance;
  media: typeof media;
  migrations: typeof migrations;
  setup: typeof setup;
  users: typeof users;
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

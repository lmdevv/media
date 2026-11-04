/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as apiKeys from "../apiKeys.js";
import type * as auth from "../auth.js";
import type * as authParams from "../authParams.js";
import type * as backups from "../backups.js";
import type * as collections from "../collections.js";
import type * as core_identity from "../core/identity.js";
import type * as core_users from "../core/users.js";
import type * as crons from "../crons.js";
import type * as deviceAuth from "../deviceAuth.js";
import type * as downloads from "../downloads.js";
import type * as history from "../history.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as jobs from "../jobs.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_bounds from "../lib/bounds.js";
import type * as lib_browse from "../lib/browse.js";
import type * as lib_catalog from "../lib/catalog.js";
import type * as lib_changes from "../lib/changes.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_directPlay from "../lib/directPlay.js";
import type * as lib_discovery from "../lib/discovery.js";
import type * as lib_endings from "../lib/endings.js";
import type * as lib_env from "../lib/env.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_genres from "../lib/genres.js";
import type * as lib_jobOutcomes from "../lib/jobOutcomes.js";
import type * as lib_jobs from "../lib/jobs.js";
import type * as lib_migrationValidators from "../lib/migrationValidators.js";
import type * as lib_people from "../lib/people.js";
import type * as lib_playable from "../lib/playable.js";
import type * as lib_playbackToken from "../lib/playbackToken.js";
import type * as lib_present from "../lib/present.js";
import type * as lib_roomClock from "../lib/roomClock.js";
import type * as lib_roots from "../lib/roots.js";
import type * as lib_scopes from "../lib/scopes.js";
import type * as lib_sessions from "../lib/sessions.js";
import type * as lib_trickplay from "../lib/trickplay.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_viewer from "../lib/viewer.js";
import type * as lib_viewing from "../lib/viewing.js";
import type * as libraries from "../libraries.js";
import type * as maintenance from "../maintenance.js";
import type * as mediaService from "../mediaService.js";
import type * as metadata from "../metadata.js";
import type * as migration from "../migration.js";
import type * as migrationService from "../migrationService.js";
import type * as myList from "../myList.js";
import type * as people from "../people.js";
import type * as playback from "../playback.js";
import type * as profiles from "../profiles.js";
import type * as rooms from "../rooms.js";
import type * as sessions from "../sessions.js";
import type * as setup from "../setup.js";
import type * as titles from "../titles.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  apiKeys: typeof apiKeys;
  auth: typeof auth;
  authParams: typeof authParams;
  backups: typeof backups;
  collections: typeof collections;
  "core/identity": typeof core_identity;
  "core/users": typeof core_users;
  crons: typeof crons;
  deviceAuth: typeof deviceAuth;
  downloads: typeof downloads;
  history: typeof history;
  http: typeof http;
  invites: typeof invites;
  jobs: typeof jobs;
  "lib/access": typeof lib_access;
  "lib/bounds": typeof lib_bounds;
  "lib/browse": typeof lib_browse;
  "lib/catalog": typeof lib_catalog;
  "lib/changes": typeof lib_changes;
  "lib/crypto": typeof lib_crypto;
  "lib/directPlay": typeof lib_directPlay;
  "lib/discovery": typeof lib_discovery;
  "lib/endings": typeof lib_endings;
  "lib/env": typeof lib_env;
  "lib/errors": typeof lib_errors;
  "lib/genres": typeof lib_genres;
  "lib/jobOutcomes": typeof lib_jobOutcomes;
  "lib/jobs": typeof lib_jobs;
  "lib/migrationValidators": typeof lib_migrationValidators;
  "lib/people": typeof lib_people;
  "lib/playable": typeof lib_playable;
  "lib/playbackToken": typeof lib_playbackToken;
  "lib/present": typeof lib_present;
  "lib/roomClock": typeof lib_roomClock;
  "lib/roots": typeof lib_roots;
  "lib/scopes": typeof lib_scopes;
  "lib/sessions": typeof lib_sessions;
  "lib/trickplay": typeof lib_trickplay;
  "lib/validators": typeof lib_validators;
  "lib/viewer": typeof lib_viewer;
  "lib/viewing": typeof lib_viewing;
  libraries: typeof libraries;
  maintenance: typeof maintenance;
  mediaService: typeof mediaService;
  metadata: typeof metadata;
  migration: typeof migration;
  migrationService: typeof migrationService;
  myList: typeof myList;
  people: typeof people;
  playback: typeof playback;
  profiles: typeof profiles;
  rooms: typeof rooms;
  sessions: typeof sessions;
  setup: typeof setup;
  titles: typeof titles;
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

/**
 * The media service's own commands, served over HTTP beside the core's Convex functions: each
 * names its route, who may call it, and its argument and result schemas. The server registers a
 * handler per command, and the SDK and CLI call them by name.
 */
import { Schema } from "effect";

import type { AnyCommand } from "./command";
import { DiagnosedSession, PlaybackDiagnostics } from "./diagnostics";
import { BackupId, PlaybackSessionId, TitleId } from "./ids";
import { LibraryRoot, MetadataCandidate, ServerFolders } from "./models/catalog";
import { Ok } from "./models/common";
import {
  ImportConnectResult,
  ImportDryRunResult,
  ImportPlanArgs,
  ImportStartResult,
  MigrationConnectArgs,
} from "./models/migration";
import { EpochMillis } from "./units";

/** Every media command by name. */
export const mediaCommands = {
  "libraries.folders": {
    summary: "List the media host's folders inside its approved library roots",
    group: "libraries",
    scope: "manage",
    args: Schema.Struct({
      /** The folder to list; omit for the approved roots themselves. */
      path: Schema.optionalKey(LibraryRoot),
    }),
    result: ServerFolders,
    route: { method: "POST", path: "/api/libraries/folders" },
  },
  "metadata.searchCandidates": {
    summary: "Search the metadata provider for matches for a title",
    group: "metadata",
    scope: "manage",
    args: Schema.Struct({
      titleId: TitleId,
      query: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      year: Schema.optionalKey(Schema.Int),
    }),
    result: Schema.Array(MetadataCandidate),
    route: { method: "POST", path: "/api/metadata/candidates" },
  },
  "backups.restore": {
    summary: "Restore the database from a backup; every session signs in again",
    group: "backups",
    scope: "admin",
    args: Schema.Struct({ backupId: BackupId }),
    result: Ok,
    route: { method: "POST", path: "/api/backups/restore" },
  },
  /*
   * The Jellyfin and Plex importer on the core (ADR 0012): the server connects to the source,
   * previews the import, and starts it as the signed-in admin. Runs are read with the core's
   * `movies.imports.list` and `movies.imports.get`.
   */
  "imports.connect": {
    summary: "Connect to a Jellyfin or Plex server to import from",
    group: "migration",
    scope: "admin",
    args: MigrationConnectArgs,
    result: ImportConnectResult,
    route: { method: "POST", path: "/api/imports/connect" },
  },
  "imports.preview": {
    summary: "Preview what an import would bring in without writing anything",
    group: "migration",
    scope: "admin",
    args: ImportPlanArgs,
    result: ImportDryRunResult,
    route: { method: "POST", path: "/api/imports/preview" },
  },
  "imports.start": {
    summary: "Import libraries, watch history, favorites, collections, and metadata overrides",
    group: "migration",
    scope: "admin",
    args: ImportPlanArgs,
    result: ImportStartResult,
    route: { method: "POST", path: "/api/imports/start" },
  },
  "diagnostics.playback": {
    summary:
      "Build the timeline of a playback session from the retained logs: streams, slow and failed segments, stalls, player errors, and recoveries",
    group: "diagnostics",
    scope: "read",
    args: Schema.Struct({
      sessionId: PlaybackSessionId,
      /**
       * The caller decodes a measured `drift`. Without it a measured drift comes back as
       * `not-measured` with the numbers in its reason, which clients before it can decode.
       */
      measuredDrift: Schema.optionalKey(Schema.Boolean),
    }),
    result: PlaybackDiagnostics,
    route: { method: "POST", path: "/api/diagnostics/playback" },
  },
  "diagnostics.sessions": {
    summary: "List playback sessions the retained logs mention, newest first",
    group: "diagnostics",
    scope: "read",
    args: Schema.Struct({
      /** Sessions seen at or after this instant; the last day when omitted. */
      since: Schema.optionalKey(EpochMillis),
    }),
    result: Schema.Array(DiagnosedSession),
    route: { method: "POST", path: "/api/diagnostics/sessions" },
  },
} satisfies Record<string, AnyCommand>;

/** A media command name such as `backups.restore`. */
export type MediaCommandName = keyof typeof mediaCommands;

/** Decoded arguments of a media command. */
export type MediaCommandArgs<Name extends MediaCommandName> =
  (typeof mediaCommands)[Name]["args"]["Type"];

/** Decoded result of a media command. */
export type MediaCommandResult<Name extends MediaCommandName> =
  (typeof mediaCommands)[Name]["result"]["Type"];

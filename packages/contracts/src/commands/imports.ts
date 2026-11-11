import {
  ImportConnectResult,
  ImportDryRunResult,
  ImportPlanArgs,
  ImportStartResult,
  MigrationConnectArgs,
} from "../models/migration";
import { media } from "./command";

/**
 * The Jellyfin and Plex importer on the core (ADR 0012): the server connects to the source,
 * previews the import, and starts it as the signed-in admin. Runs are read with the core's
 * `movies.imports.list` and `movies.imports.get`.
 */
export const importCommands = {
  "imports.connect": media({
    summary: "Connect to a Jellyfin or Plex server to import from",
    group: "migration",
    scope: "admin",
    args: MigrationConnectArgs,
    result: ImportConnectResult,
    route: { method: "POST", path: "/api/imports/connect" },
  }),
  "imports.preview": media({
    summary: "Preview what an import would bring in without writing anything",
    group: "migration",
    scope: "admin",
    args: ImportPlanArgs,
    result: ImportDryRunResult,
    route: { method: "POST", path: "/api/imports/preview" },
  }),
  "imports.start": media({
    summary: "Import libraries, watch history, favorites, collections, and metadata overrides",
    group: "migration",
    scope: "admin",
    args: ImportPlanArgs,
    result: ImportStartResult,
    route: { method: "POST", path: "/api/imports/start" },
  }),
};

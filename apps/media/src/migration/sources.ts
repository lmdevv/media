import type { MigrationSource } from "@media/contracts/models/jobs";
import { Effect } from "effect";
import type { HttpClient } from "effect/http";

import * as Jellyfin from "./jellyfin.ts";
import * as Plex from "./plex.ts";
import type { SourceError, SourceSession, SourceTarget } from "./source-plugin.ts";

/** Tags of every source failure, for recovering them into the "Couldn't connect" result. */
export const SOURCE_ERROR_TAGS = [
  "SourceUnreachable",
  "SourceAuthFailed",
  "SourceNotAdmin",
  "SourceVersionUnsupported",
  "SourceUnexpectedResponse",
  "SourceRequestDenied",
] as const;

/** Opens `source` at `target` with its plugin. */
export const openSource = (
  source: MigrationSource,
  target: SourceTarget,
): Effect.Effect<SourceSession, SourceError, HttpClient.HttpClient> =>
  (source === "jellyfin" ? Jellyfin.make : Plex.make).pipe(
    Effect.flatMap((plugin) => plugin.open(target)),
  );

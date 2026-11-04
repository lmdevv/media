import type { MigrationCredentials } from "@media/contracts/models/migration";
import type { MetadataOverrides } from "@media/contracts/models/catalog";
import type { MigrationSource } from "@media/contracts/models/jobs";
import type { SourceFailureReason } from "@media/contracts/models/migration";
import { Effect, Match, Schema } from "effect";
import { HttpClient, type HttpClientError } from "effect/http";

const SourcePermissions = Schema.Struct({
  hosts: Schema.Array(Schema.String),
  methods: Schema.Array(Schema.Literals(["GET", "POST"])),
  postPaths: Schema.Array(Schema.String),
  paths: Schema.Array(Schema.String),
});

/** Identity, role, and permissions of a migration-source plugin for one server. */
export const SourceManifest = Schema.Struct({
  id: Schema.Literals(["jellyfin", "plex"]),
  name: Schema.String,
  version: Schema.String,
  role: Schema.Literal("migration-source"),
  permissions: SourcePermissions,
});

/** Identity, role, and permissions of a migration-source plugin. */
export interface SourceManifest extends Schema.Schema.Type<typeof SourceManifest> {}

/** The source server. */
export interface SourceServer {
  /** The server's own identifier, stable across restarts and URL changes. */
  readonly serverId: string;
  readonly name: string;
  readonly version: string;
}

/** A person with an account on the source server. */
export interface SourceUser {
  readonly userId: string;
  readonly name: string;
  readonly email: string | null;
  readonly isAdmin: boolean;
  /** `plays`: only the server's play history is readable for this user. */
  readonly history: "full" | "plays";
}

/** Which source users can see a library: all of them, the listed ones, or unknown. */
export type SourceLibraryAccess =
  | { readonly kind: "everyone" }
  | { readonly kind: "users"; readonly userIds: ReadonlyArray<string> }
  | { readonly kind: "unknown" };

/** A library and its folders, as the source reports them. */
export interface SourceLibrary {
  readonly libraryId: string;
  readonly name: string;
  readonly kind: "movies" | "shows" | "mixed" | "other";
  readonly paths: ReadonlyArray<string>;
  /** Who could see it on the source; the import shares an added library the same way. */
  readonly access: SourceLibraryAccess;
}

/** Provider identifiers the source knows for an item. */
export interface ProviderIds {
  readonly tmdb: string | null;
  readonly imdb: string | null;
  readonly tvdb: string | null;
}

/** A movie, a show, or an episode. */
export interface SourceItem {
  readonly itemId: string;
  readonly kind: "movie" | "series" | "episode";
  readonly name: string;
  readonly libraryId: string;
  /** The item's files (episodes and movies) or folder (shows); several for multi-version movies. */
  readonly paths: ReadonlyArray<string>;
  readonly ids: ProviderIds;
  /** The episode's show. */
  readonly seriesId: string | null;
  readonly seasonNumber: number | null;
  readonly episodeNumber: number | null;
  /** Metadata an admin locked or customised on the source; empty when none. */
  readonly overrides: MetadataOverrides;
}

/** One user's state for one item. Only items with something to import are listed. */
export interface SourceItemState {
  readonly itemId: string;
  readonly played: boolean;
  readonly positionMs: number;
  readonly playCount: number;
  /** Milliseconds since the epoch; null when the source does not say. */
  readonly lastPlayedAt: number | null;
  readonly favorite: boolean;
}

/** A collection (Jellyfin box set, Plex collection) and its members' item IDs, in order. */
export interface SourceCollection {
  readonly collectionId: string;
  readonly name: string;
  readonly sortName: string | null;
  readonly itemIds: ReadonlyArray<string>;
}

/** The source server cannot be reached: wrong URL, server down, timeout, or TLS failure. */
export class SourceUnreachable extends Schema.TaggedError<SourceUnreachable>()(
  "SourceUnreachable",
  {
    source: Schema.Literals(["jellyfin", "plex"]),
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Source unreachable: ${this.source} ${this.operation} (${this.detail})`;
  }
}

/** The source refused the credentials. */
export class SourceAuthFailed extends Schema.TaggedError<SourceAuthFailed>()("SourceAuthFailed", {
  source: Schema.Literals(["jellyfin", "plex"]),
}) {
  override get message(): string {
    return `Source sign-in failed: ${this.source} refused the token or password`;
  }
}

/** The credentials work but are not an administrator's. */
export class SourceNotAdmin extends Schema.TaggedError<SourceNotAdmin>()("SourceNotAdmin", {
  source: Schema.Literals(["jellyfin", "plex"]),
}) {
  override get message(): string {
    return `Source access too narrow: ${this.source} needs an administrator's credentials to read every user`;
  }
}

/** The source is older than the plugin supports. */
export class SourceVersionUnsupported extends Schema.TaggedError<SourceVersionUnsupported>()(
  "SourceVersionUnsupported",
  {
    source: Schema.Literals(["jellyfin", "plex"]),
    version: Schema.String,
    minimum: Schema.String,
  },
) {
  override get message(): string {
    return `Source version unsupported: ${this.source} ${this.version} is older than ${this.minimum}`;
  }
}

/** The source answered, but not as expected: another kind of server, or a changed API. */
export class SourceUnexpectedResponse extends Schema.TaggedError<SourceUnexpectedResponse>()(
  "SourceUnexpectedResponse",
  {
    source: Schema.Literals(["jellyfin", "plex"]),
    operation: Schema.String,
    status: Schema.NullOr(Schema.Int),
    /** What went wrong, without URLs or headers (they may carry the token). */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Source answered unexpectedly: ${this.source} ${this.operation} (status ${String(this.status)}): ${this.detail}`;
  }
}

/** The plugin tried a request its manifest does not allow. */
export class SourceRequestDenied extends Schema.TaggedError<SourceRequestDenied>()(
  "SourceRequestDenied",
  { plugin: Schema.String, method: Schema.String, host: Schema.String },
) {
  override get message(): string {
    return `Source request denied: ${this.plugin} may not ${this.method} ${this.host}`;
  }
}

/** Every failure reading a source. */
export type SourceError =
  | SourceUnreachable
  | SourceAuthFailed
  | SourceNotAdmin
  | SourceVersionUnsupported
  | SourceUnexpectedResponse
  | SourceRequestDenied;

/** The reason the "Couldn't connect" screen shows for a source failure. */
export const failureReasonOf: (error: SourceError) => SourceFailureReason =
  Match.type<SourceError>().pipe(
    Match.tagsExhaustive({
      SourceUnreachable: () => "unreachable" as const,
      SourceAuthFailed: () => "auth_failed" as const,
      SourceNotAdmin: () => "not_admin" as const,
      SourceVersionUnsupported: () => "version_unsupported" as const,
      SourceUnexpectedResponse: () => "unexpected_response" as const,
      SourceRequestDenied: () => "unexpected_response" as const,
    }),
  );

/** A signed-in, read-only view of a source server. */
export interface SourceSession {
  readonly manifest: SourceManifest;
  readonly server: SourceServer;
  readonly users: ReadonlyArray<SourceUser>;
  readonly libraries: ReadonlyArray<SourceLibrary>;
  /** Movies, shows, and episodes of every movie, show, and mixed library. Read once and kept. */
  readonly items: Effect.Effect<ReadonlyArray<SourceItem>, SourceError>;
  /** One user's watched marks, positions, play counts, and favorites. */
  readonly userStates: (
    user: SourceUser,
  ) => Effect.Effect<ReadonlyArray<SourceItemState>, SourceError>;
  readonly collections: Effect.Effect<ReadonlyArray<SourceCollection>, SourceError>;
}

/** Where a plugin connects. */
export interface SourceTarget {
  /** Base URL without a trailing slash. */
  readonly url: string;
  readonly credentials: MigrationCredentials;
}

/** A migration-source plugin. */
export interface MigrationSourcePlugin {
  readonly source: MigrationSource;
  /** Checks the server, signs in, and reads its users and libraries. */
  readonly open: (target: SourceTarget) => Effect.Effect<SourceSession, SourceError>;
}

/**
 * Wraps `client` so a request to a host outside the manifest, or a method or POST path it does
 * not allow, fails with `SourceRequestDenied` before any bytes leave the process.
 */
export const guardSourceRequests = (
  manifest: SourceManifest,
  client: HttpClient.HttpClient,
): HttpClient.HttpClient.With<HttpClientError.HttpClientError | SourceRequestDenied> => {
  const hosts = new Set(manifest.permissions.hosts.map((host) => host.toLowerCase()));
  const methods: ReadonlySet<string> = new Set(manifest.permissions.methods);
  const postPaths = new Set(manifest.permissions.postPaths);

  return HttpClient.mapRequestEffect(client, (request) => {
    const url = new URL(request.url);
    const host = url.host.toLowerCase();

    const allowed =
      hosts.has(host) &&
      methods.has(request.method) &&
      (request.method !== "POST" || postPaths.has(url.pathname));

    return allowed
      ? Effect.succeed(request)
      : Effect.fail(new SourceRequestDenied({ plugin: manifest.id, method: request.method, host }));
  });
};

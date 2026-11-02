/**
 * The in-repo Plex migration-source plugin. It reads a Plex Media Server (1.24 or later, for
 * `includeGuids`) through its local HTTP API with the `X-Plex-Token` header and JSON responses,
 * written from Plex's published API documentation. plex.tv is never contacted: a local server
 * token is enough, and every request is a GET.
 *
 * What a server token can read: the libraries, their items with provider IDs and file paths, the
 * token owner's own watched marks, positions, play counts, and last-played dates, the server's play
 * history for every local account, collections, and locked metadata fields. Plex has no favorites
 * (its watchlist lives on plex.tv), and other accounts' positions are only on plex.tv, so other
 * accounts import watched marks, play counts, and last-played dates from the play history.
 */
import type { MetadataOverrides } from "@movies/contracts/models/catalog";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";

import { allPages, makeSourceHttp, type SourceHttp } from "./source-http.ts";
import type {
  MigrationSourcePlugin,
  ProviderIds,
  SourceCollection,
  SourceItem,
  SourceItemState,
  SourceLibrary,
  SourceManifest,
  SourceSession,
  SourceTarget,
  SourceUser,
} from "./source-plugin.ts";
import { SourceAuthFailed, SourceNotAdmin, SourceVersionUnsupported } from "./source-plugin.ts";
import { isVersionAtLeast } from "./versions.ts";

const MINIMUM_VERSION = "1.24.0";

const PAGE_SIZE = 500;

/** Plex's local account ID of the server owner. */
const OWNER_ACCOUNT_ID = 1;

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const container = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct({ MediaContainer: Schema.Struct(fields) });

const Identity = container({
  machineIdentifier: Schema.String,
  version: Schema.String,
});

const ServerRoot = container({
  machineIdentifier: Schema.String,
  version: Schema.String,
  friendlyName: optional(Schema.String),
});

const Accounts = container({
  Account: optional(Schema.Array(Schema.Struct({ id: Schema.Int, name: optional(Schema.String) }))),
});

const Sections = container({
  Directory: optional(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        type: Schema.String,
        title: Schema.String,
        Location: optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
      }),
    ),
  ),
});

const Metadata = Schema.Struct({
  ratingKey: Schema.String,
  type: optional(Schema.String),
  title: optional(Schema.String),
  titleSort: optional(Schema.String),
  year: optional(Schema.Int),
  summary: optional(Schema.String),
  contentRating: optional(Schema.String),
  grandparentRatingKey: optional(Schema.String),
  parentIndex: optional(Schema.Int),
  index: optional(Schema.Int),
  Guid: optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
  Media: optional(
    Schema.Array(
      Schema.Struct({
        Part: optional(Schema.Array(Schema.Struct({ file: optional(Schema.String) }))),
      }),
    ),
  ),
  Location: optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
  Field: optional(
    Schema.Array(Schema.Struct({ name: Schema.String, locked: optional(Schema.Boolean) })),
  ),
  viewCount: optional(Schema.Finite),
  viewOffset: optional(Schema.Finite),
  lastViewedAt: optional(Schema.Finite),
});

type Metadata = typeof Metadata.Type;

const MetadataPage = container({
  totalSize: optional(Schema.Int),
  Metadata: optional(Schema.Array(Metadata)),
});

const History = container({
  totalSize: optional(Schema.Int),
  Metadata: optional(
    Schema.Array(
      Schema.Struct({
        ratingKey: optional(Schema.String),
        viewedAt: optional(Schema.Finite),
      }),
    ),
  ),
});

const LISTING_TYPES = { movie: 1, series: 2, episode: 4 } as const;

const text = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === "" ? null : value.trim();

/** Provider IDs from `Guid` entries such as `tmdb://603` and `imdb://tt0133093`. */
const providerIds = (guids: Metadata["Guid"]): ProviderIds => {
  const lookup = (scheme: string): string | null =>
    text(
      (guids ?? []).find((guid) => guid.id.startsWith(`${scheme}://`))?.id.slice(scheme.length + 3),
    );

  return { tmdb: lookup("tmdb"), imdb: lookup("imdb"), tvdb: lookup("tvdb") };
};

const overridesOf = (item: Metadata): MetadataOverrides => {
  const locked = new Set(
    (item.Field ?? []).flatMap((field) => (field.locked === true ? [field.name] : [])),
  );

  const overrides: { -readonly [Key in keyof MetadataOverrides]: MetadataOverrides[Key] } = {};
  const name = text(item.title);
  const sortName = text(item.titleSort);
  const overview = text(item.summary);
  const certification = text(item.contentRating);

  if (locked.has("title") && name !== null) overrides.name = name;

  if (locked.has("titleSort") && sortName !== null) overrides.sortName = sortName;

  if (locked.has("year") && item.year !== undefined && item.year !== null) {
    overrides.year = item.year;
  }

  if (locked.has("summary") && overview !== null) overrides.overview = overview;

  if (locked.has("contentRating") && certification !== null) {
    overrides.certification = certification;
  }

  return overrides;
};

const filesOf = (item: Metadata): ReadonlyArray<string> =>
  (item.Media ?? []).flatMap((media) =>
    (media.Part ?? []).flatMap((part) => {
      const file = text(part.file);

      return file === null ? [] : [file];
    }),
  );

const libraryKind = (type: string): SourceLibrary["kind"] => {
  if (type === "movie") return "movies";

  return type === "show" ? "shows" : "other";
};

const seconds = (value: number | null | undefined): number | null =>
  value === null || value === undefined || value <= 0 ? null : Math.floor(value * 1000);

const ownerStateOf = (item: Metadata): SourceItemState | null => {
  const playCount = Math.max(0, Math.floor(item.viewCount ?? 0));
  const positionMs = Math.max(0, Math.floor(item.viewOffset ?? 0));

  if (playCount === 0 && positionMs === 0) return null;

  return {
    itemId: item.ratingKey,
    played: playCount > 0,
    positionMs,
    playCount,
    lastPlayedAt: seconds(item.lastViewedAt),
    favorite: false,
  };
};

const manifestFor = (url: URL): SourceManifest => ({
  id: "plex",
  name: "Plex",
  version: "1.0.0",
  role: "migration-source",
  permissions: { hosts: [url.host], methods: ["GET"], postPaths: [], paths: [] },
});

const metadataPages = (
  http: SourceHttp,
  operation: string,
  path: string,
  params: Readonly<Record<string, string | number>>,
) =>
  allPages(PAGE_SIZE, (start) =>
    http
      .get(
        operation,
        path,
        { ...params, "X-Plex-Container-Start": start, "X-Plex-Container-Size": PAGE_SIZE },
        MetadataPage,
      )
      .pipe(
        Effect.map((page) => ({
          items: page.MediaContainer.Metadata ?? [],
          total: page.MediaContainer.totalSize ?? null,
        })),
      ),
  );

interface Listing {
  readonly library: SourceLibrary;
  readonly kind: SourceItem["kind"];
  readonly items: ReadonlyArray<Metadata>;
}

const openSession = Effect.fnUntraced(function* (target: SourceTarget) {
  if (target.credentials.kind !== "token") {
    return yield* new SourceAuthFailed({ source: "plex" });
  }

  const url = new URL(target.url);
  const manifest = manifestFor(url);
  const token = Redacted.value(target.credentials.token);

  const http = yield* makeSourceHttp({
    source: "plex",
    manifest,
    baseUrl: target.url,
    headers: {
      "x-plex-token": token,
      "x-plex-product": "[movies] migration",
      "x-plex-client-identifier": "movies-migration",
    },
    camelCaseKeys: false,
  });

  const identity = yield* http.get("identity", "/identity", {}, Identity);

  if (!isVersionAtLeast(identity.MediaContainer.version, MINIMUM_VERSION)) {
    return yield* new SourceVersionUnsupported({
      source: "plex",
      version: identity.MediaContainer.version,
      minimum: MINIMUM_VERSION,
    });
  }

  const root = yield* http.get("server", "/", {}, ServerRoot);

  // Only the server owner's token may list the server's accounts. The token already worked on
  // `/`, so a refusal here means a shared user's token, not a wrong one.
  const accounts = yield* http
    .get("accounts", "/accounts", {}, Accounts)
    .pipe(
      Effect.catchTag("SourceAuthFailed", () =>
        Effect.fail(new SourceNotAdmin({ source: "plex" })),
      ),
    );

  const sections = yield* http.get("libraries", "/library/sections", {}, Sections);

  const users = (accounts.MediaContainer.Account ?? []).flatMap((account): Array<SourceUser> => {
    const name = text(account.name);

    return account.id <= 0 || name === null
      ? []
      : [
          {
            userId: String(account.id),
            name,
            email: null,
            isAdmin: account.id === OWNER_ACCOUNT_ID,
            history: account.id === OWNER_ACCOUNT_ID ? "full" : "plays",
          },
        ];
  });

  const libraries = (sections.MediaContainer.Directory ?? []).map((section): SourceLibrary => ({
    libraryId: section.key,
    name: section.title,
    kind: libraryKind(section.type),
    paths: (section.Location ?? []).map((location) => location.path),
    // A local server token cannot read which libraries the owner shared with whom (plex.tv
    // holds that), so the import opens added libraries to admins only.
    access: { kind: "unknown" },
  }));

  const videoLibraries = libraries.filter((library) => library.kind !== "other");

  const listings = yield* Effect.cached(
    Effect.forEach(videoLibraries, (library) => {
      const kinds: ReadonlyArray<SourceItem["kind"]> =
        library.kind === "movies" ? ["movie"] : ["series", "episode"];

      return Effect.forEach(kinds, (kind) =>
        metadataPages(http, "items", `/library/sections/${library.libraryId}/all`, {
          type: LISTING_TYPES[kind],
          includeGuids: 1,
        }).pipe(Effect.map((items): Listing => ({ library, kind, items }))),
      );
    }).pipe(Effect.map((perLibrary) => perLibrary.flat())),
  );

  const items = yield* Effect.cached(
    listings.pipe(
      Effect.map((all) => {
        // Episodes carry their own GUIDs; their show's IDs come from the show entry.
        return all.flatMap(({ library, kind, items: listed }) =>
          listed.map((item): SourceItem => ({
            itemId: item.ratingKey,
            kind,
            name: text(item.title) ?? item.ratingKey,
            libraryId: library.libraryId,
            paths:
              kind === "series"
                ? (item.Location ?? []).map((location) => location.path)
                : filesOf(item),
            ids: providerIds(item.Guid),
            seriesId: kind === "episode" ? text(item.grandparentRatingKey) : null,
            seasonNumber: kind === "episode" ? (item.parentIndex ?? null) : null,
            episodeNumber: kind === "episode" ? (item.index ?? null) : null,
            overrides: kind === "episode" ? {} : overridesOf(item),
          })),
        );
      }),
    ),
  );

  const historyStates = (user: SourceUser) =>
    allPages(PAGE_SIZE, (start) =>
      http
        .get(
          "history",
          "/status/sessions/history/all",
          {
            accountID: user.userId,
            sort: "viewedAt:desc",
            "X-Plex-Container-Start": start,
            "X-Plex-Container-Size": PAGE_SIZE,
          },
          History,
        )
        .pipe(
          Effect.map((page) => ({
            items: page.MediaContainer.Metadata ?? [],
            total: page.MediaContainer.totalSize ?? null,
          })),
        ),
    ).pipe(
      Effect.map((plays) => {
        const states = new Map<string, SourceItemState>();

        for (const play of plays) {
          const itemId = text(play.ratingKey);

          if (itemId === null) continue;
          const viewedAt = seconds(play.viewedAt);
          const known = states.get(itemId);

          states.set(itemId, {
            itemId,
            played: true,
            positionMs: 0,
            playCount: (known?.playCount ?? 0) + 1,
            lastPlayedAt: Math.max(known?.lastPlayedAt ?? 0, viewedAt ?? 0) || null,
            favorite: false,
          });
        }

        return [...states.values()];
      }),
    );

  const userStates = (user: SourceUser) =>
    user.history === "full"
      ? listings.pipe(
          Effect.map((all) =>
            all.flatMap(({ kind, items: listed }) =>
              kind === "series"
                ? []
                : listed.flatMap((item) => {
                    const state = ownerStateOf(item);

                    return state === null ? [] : [state];
                  }),
            ),
          ),
        )
      : historyStates(user);

  const collections = yield* Effect.cached(
    Effect.forEach(videoLibraries, (library) =>
      metadataPages(http, "collections", `/library/sections/${library.libraryId}/collections`, {}),
    ).pipe(
      Effect.flatMap((perLibrary) =>
        Effect.forEach(perLibrary.flat(), (collection) =>
          metadataPages(
            http,
            "collectionItems",
            `/library/collections/${collection.ratingKey}/children`,
            {},
          ).pipe(
            Effect.map((members): SourceCollection => ({
              collectionId: collection.ratingKey,
              name: text(collection.title) ?? collection.ratingKey,
              sortName: text(collection.titleSort),
              itemIds: members.map((member) => member.ratingKey),
            })),
          ),
        ),
      ),
    ),
  );

  const session: SourceSession = {
    manifest,
    server: {
      serverId: root.MediaContainer.machineIdentifier,
      name: text(root.MediaContainer.friendlyName) ?? "Plex",
      version: root.MediaContainer.version,
    },
    users,
    libraries,
    items,
    userStates,
    collections,
  };

  return session;
});

/** The Plex plugin over the process's HTTP client. */
export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const plugin: MigrationSourcePlugin = {
    source: "plex",
    open: (target) =>
      openSession(target).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.withSpan("Plex.open"),
      ),
  };

  return plugin;
});

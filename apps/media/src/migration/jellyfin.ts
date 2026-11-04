/**
 * The in-repo Jellyfin migration-source plugin. It reads a Jellyfin 10.8 or later server through
 * its public HTTP API (`/System/Info/Public`, `/Users`, `/Library/VirtualFolders`, and `/Items`),
 * written from Jellyfin's published API documentation; no Jellyfin code is used.
 *
 * It signs in with an API key, or with an administrator's user name and password through
 * `POST /Users/AuthenticateByName`, the only request that is not a GET. Every request carries
 * `Authorization: MediaBrowser ... Token="..."`, which Jellyfin accepts on every supported version;
 * the legacy `X-Emby-Token` header is off by default on current servers.
 */
import type { MetadataOverrides } from "@media/contracts/models/catalog";
import { DateTime, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";

import { allPages, makeSourceHttp, type SourceHttp } from "./source-http.ts";
import type {
  MigrationSourcePlugin,
  SourceCollection,
  SourceItem,
  SourceItemState,
  SourceLibrary,
  SourceLibraryAccess,
  SourceManifest,
  SourceSession,
  SourceTarget,
  SourceUser,
} from "./source-plugin.ts";
import { SourceAuthFailed, SourceVersionUnsupported } from "./source-plugin.ts";
import { isVersionAtLeast } from "./versions.ts";

const MINIMUM_VERSION = "10.8.0";

const PAGE_SIZE = 500;

/** One Jellyfin tick is 100 nanoseconds. */
const TICKS_PER_MS = 10_000;

const SIGN_IN_PATH = "/Users/AuthenticateByName";

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const PublicInfo = Schema.Struct({
  id: Schema.String,
  serverName: optional(Schema.String),
  version: Schema.String,
  productName: optional(Schema.String),
});

const AuthenticationResult = Schema.Struct({
  accessToken: Schema.String,
  user: Schema.Struct({
    id: Schema.String,
    policy: optional(Schema.Struct({ isAdministrator: optional(Schema.Boolean) })),
  }),
});

const Users = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    policy: optional(
      Schema.Struct({
        isAdministrator: optional(Schema.Boolean),
        isDisabled: optional(Schema.Boolean),
        enableAllFolders: optional(Schema.Boolean),
        enabledFolders: optional(Schema.Array(Schema.String)),
      }),
    ),
  }),
);

const VirtualFolders = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    itemId: optional(Schema.String),
    collectionType: optional(Schema.String),
    locations: optional(Schema.Array(Schema.String)),
  }),
);

const UserData = Schema.Struct({
  playbackPositionTicks: optional(Schema.Finite),
  playCount: optional(Schema.Finite),
  isFavorite: optional(Schema.Boolean),
  played: optional(Schema.Boolean),
  lastPlayedDate: optional(Schema.String),
});

const Item = Schema.Struct({
  id: Schema.String,
  name: optional(Schema.String),
  type: Schema.String,
  path: optional(Schema.String),
  providerIds: optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  seriesId: optional(Schema.String),
  parentIndexNumber: optional(Schema.Int),
  indexNumber: optional(Schema.Int),
  productionYear: optional(Schema.Int),
  overview: optional(Schema.String),
  officialRating: optional(Schema.String),
  forcedSortName: optional(Schema.String),
  sortName: optional(Schema.String),
  lockData: optional(Schema.Boolean),
  lockedFields: optional(Schema.Array(Schema.String)),
  userData: optional(UserData),
});

type Item = typeof Item.Type;

const ItemPage = Schema.Struct({
  items: Schema.Array(Item),
  totalRecordCount: optional(Schema.Int),
});

const text = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === "" ? null : value.trim();

/** Provider IDs; Jellyfin's keys are `Tmdb`, `Imdb`, and `Tvdb` (case varies by version). */
const providerIds = (ids: Item["providerIds"]) => {
  const lookup = (name: string): string | null => {
    const entry = Object.entries(ids ?? {}).find(([key]) => key.toLowerCase() === name);

    return text(entry?.[1]);
  };

  return { tmdb: lookup("tmdb"), imdb: lookup("imdb"), tvdb: lookup("tvdb") };
};

/**
 * Metadata the admin locked: every field when the whole item is locked, otherwise the locked
 * `Name`, `Overview`, and `OfficialRating` fields. A forced sort name is always an admin edit.
 */
const overridesOf = (item: Item): MetadataOverrides => {
  const locked = new Set(item.lockedFields ?? []);
  const all = item.lockData === true;
  const name = text(item.name);
  const overview = text(item.overview);
  const certification = text(item.officialRating);
  const sortName = text(item.forcedSortName);

  const overrides: { -readonly [Key in keyof MetadataOverrides]: MetadataOverrides[Key] } = {};

  if ((all || locked.has("Name")) && name !== null) overrides.name = name;

  if (sortName !== null) overrides.sortName = sortName;

  if (all && item.productionYear !== undefined && item.productionYear !== null) {
    overrides.year = item.productionYear;
  }

  if ((all || locked.has("Overview")) && overview !== null) overrides.overview = overview;

  if ((all || locked.has("OfficialRating")) && certification !== null) {
    overrides.certification = certification;
  }

  return overrides;
};

const kindOf = (type: string): SourceItem["kind"] | null => {
  if (type === "Movie") return "movie";

  if (type === "Series") return "series";

  return type === "Episode" ? "episode" : null;
};

type JellyfinUser = (typeof Users.Type)[number];

/** Jellyfin writes folder IDs with dashes in policies and without them on virtual folders. */
const folderKey = (id: string): string => id.replaceAll("-", "").toLowerCase();

const userSees = (user: JellyfinUser, libraryId: string): boolean | null => {
  const policy = user.policy;

  if (policy?.enableAllFolders === true) return true;

  if (policy?.enableAllFolders === undefined || policy.enableAllFolders === null) return null;

  return (policy.enabledFolders ?? []).some((folder) => folderKey(folder) === folderKey(libraryId));
};

const accessOf = (users: ReadonlyArray<JellyfinUser>, libraryId: string): SourceLibraryAccess => {
  const seen = users.map((user) => ({ userId: user.id, sees: userSees(user, libraryId) }));

  if (seen.length === 0) return { kind: "unknown" };

  if (seen.every(({ sees }) => sees === true)) return { kind: "everyone" };

  if (seen.every(({ sees }) => sees === null)) return { kind: "unknown" };

  return {
    kind: "users",
    userIds: seen.flatMap(({ userId, sees }) => (sees === true ? [userId] : [])),
  };
};

const libraryKind = (collectionType: string | null | undefined): SourceLibrary["kind"] => {
  if (collectionType === "movies") return "movies";

  if (collectionType === "tvshows") return "shows";

  return collectionType === null || collectionType === undefined || collectionType === "mixed"
    ? "mixed"
    : "other";
};

const toEpochMillis = (date: string | null | undefined): number | null =>
  date === null || date === undefined
    ? null
    : Option.match(DateTime.make(date), {
        onNone: () => null,
        onSome: DateTime.toEpochMillis,
      });

const stateOf = (item: Item): SourceItemState | null => {
  const data = item.userData;

  if (data === null || data === undefined) return null;
  const positionMs = Math.max(0, Math.floor((data.playbackPositionTicks ?? 0) / TICKS_PER_MS));
  const playCount = Math.max(0, Math.floor(data.playCount ?? 0));
  const played = data.played === true;
  const favorite = data.isFavorite === true;

  if (!played && positionMs === 0 && playCount === 0 && !favorite) return null;

  return {
    itemId: item.id,
    played,
    positionMs,
    playCount,
    lastPlayedAt: toEpochMillis(data.lastPlayedDate),
    favorite,
  };
};

/** The `Authorization` header; Jellyfin identifies the client and device by these fields. */
const authorization = (token: Option.Option<string>): string => {
  const fields = [
    'Client="[movies] migration"',
    'Device="[movies]"',
    'DeviceId="movies-migration"',
    'Version="1.0.0"',
  ];

  return `MediaBrowser ${Option.match(token, {
    onNone: () => fields,
    onSome: (value) => [...fields, `Token="${value}"`],
  }).join(", ")}`;
};

const manifestFor = (url: URL): SourceManifest => ({
  id: "jellyfin",
  name: "Jellyfin",
  version: "1.0.0",
  role: "migration-source",
  permissions: {
    hosts: [url.host],
    methods: ["GET", "POST"],
    postPaths: [`${url.pathname.replace(/\/+$/u, "")}${SIGN_IN_PATH}`],
    paths: [],
  },
});

const ITEM_FIELDS = "Path,ProviderIds,Settings,SortName,Overview";

const VIDEO_TYPES = "Movie,Series,Episode";

const itemPages = (
  http: SourceHttp,
  operation: string,
  params: Readonly<Record<string, string | boolean>>,
) =>
  allPages(PAGE_SIZE, (start) =>
    http
      .get(
        operation,
        "/Items",
        { ...params, StartIndex: start, Limit: PAGE_SIZE, EnableImages: false },
        ItemPage,
      )
      .pipe(Effect.map((page) => ({ items: page.items, total: page.totalRecordCount ?? null }))),
  );

const openSession = Effect.fnUntraced(function* (target: SourceTarget) {
  const url = new URL(target.url);
  const manifest = manifestFor(url);

  const anonymous = yield* makeSourceHttp({
    source: "jellyfin",
    manifest,
    baseUrl: target.url,
    headers: { authorization: authorization(Option.none()) },
    camelCaseKeys: true,
  });

  const info = yield* anonymous.get("publicInfo", "/System/Info/Public", {}, PublicInfo);

  if (!isVersionAtLeast(info.version, MINIMUM_VERSION)) {
    return yield* new SourceVersionUnsupported({
      source: "jellyfin",
      version: info.version,
      minimum: MINIMUM_VERSION,
    });
  }

  const token =
    target.credentials.kind === "token"
      ? Redacted.value(target.credentials.token)
      : (yield* anonymous.post(
          "signIn",
          SIGN_IN_PATH,
          {
            Username: target.credentials.username,
            Pw: Redacted.value(target.credentials.password),
          },
          AuthenticationResult,
        )).accessToken;

  if (token.trim() === "") return yield* new SourceAuthFailed({ source: "jellyfin" });

  const http = yield* makeSourceHttp({
    source: "jellyfin",
    manifest,
    baseUrl: target.url,
    headers: { authorization: authorization(Option.some(token)) },
    camelCaseKeys: true,
  });

  // Listing every user needs an administrator; Jellyfin answers 403 otherwise.
  const users = yield* http.get("users", "/Users", {}, Users);
  const folders = yield* http.get("libraries", "/Library/VirtualFolders", {}, VirtualFolders);

  const activeUsers = users.filter((user) => user.policy?.isDisabled !== true);

  const libraries = folders.flatMap((folder): Array<SourceLibrary> => {
    const libraryId = text(folder.itemId);

    return libraryId === null
      ? []
      : [
          {
            libraryId,
            name: folder.name,
            kind: libraryKind(folder.collectionType),
            paths: folder.locations ?? [],
            access: accessOf(activeUsers, libraryId),
          },
        ];
  });

  const sourceUsers = activeUsers.map((user): SourceUser => ({
    userId: user.id,
    name: user.name,
    email: null,
    isAdmin: user.policy?.isAdministrator === true,
    history: "full",
  }));

  const videoLibraries = libraries.filter((library) => library.kind !== "other");

  const items = yield* Effect.cached(
    Effect.forEach(videoLibraries, (library) =>
      itemPages(http, "items", {
        ParentId: library.libraryId,
        Recursive: true,
        IncludeItemTypes: VIDEO_TYPES,
        Fields: ITEM_FIELDS,
        EnableUserData: false,
        // Otherwise a library lists a box set in place of the movies in it.
        CollapseBoxSetItems: false,
      }).pipe(
        Effect.map((found) =>
          found.flatMap((item): Array<SourceItem> => {
            const kind = kindOf(item.type);
            const path = text(item.path);

            return kind === null
              ? []
              : [
                  {
                    itemId: item.id,
                    kind,
                    name: text(item.name) ?? item.id,
                    libraryId: library.libraryId,
                    paths: path === null ? [] : [path],
                    ids: providerIds(item.providerIds),
                    seriesId: text(item.seriesId),
                    seasonNumber: kind === "episode" ? (item.parentIndexNumber ?? null) : null,
                    episodeNumber: kind === "episode" ? (item.indexNumber ?? null) : null,
                    overrides: overridesOf(item),
                  },
                ];
          }),
        ),
      ),
    ).pipe(Effect.map((perLibrary) => perLibrary.flat())),
  );

  const userStates = (user: SourceUser) =>
    Effect.forEach(["IsPlayed", "IsResumable", "IsFavorite"], (filter) =>
      itemPages(http, "userItems", {
        userId: user.userId,
        Recursive: true,
        IncludeItemTypes: VIDEO_TYPES,
        Filters: filter,
        EnableUserData: true,
        CollapseBoxSetItems: false,
      }),
    ).pipe(
      Effect.map((pages) => {
        const states = new Map<string, SourceItemState>();

        for (const item of pages.flat()) {
          const state = stateOf(item);

          if (state !== null) states.set(item.id, state);
        }

        return [...states.values()];
      }),
    );

  // Box set members are listed only for a user; an administrator sees every library.
  const viewer = sourceUsers.find((user) => user.isAdmin)?.userId;

  const asViewer = (params: Readonly<Record<string, string | boolean>>) =>
    viewer === undefined ? params : { ...params, userId: viewer };

  const collections = yield* Effect.cached(
    itemPages(
      http,
      "collections",
      asViewer({ Recursive: true, IncludeItemTypes: "BoxSet", Fields: "SortName" }),
    ).pipe(
      Effect.flatMap((boxSets) =>
        Effect.forEach(boxSets, (boxSet) =>
          itemPages(
            http,
            "collectionItems",
            asViewer({ ParentId: boxSet.id, Fields: "SortName", CollapseBoxSetItems: false }),
          ).pipe(
            Effect.map((members): SourceCollection => ({
              collectionId: boxSet.id,
              name: text(boxSet.name) ?? boxSet.id,
              sortName: text(boxSet.forcedSortName),
              itemIds: members.map((member) => member.id),
            })),
          ),
        ),
      ),
    ),
  );

  const session: SourceSession = {
    manifest,
    server: { serverId: info.id, name: text(info.serverName) ?? "Jellyfin", version: info.version },
    users: sourceUsers,
    libraries,
    items,
    userStates,
    collections,
  };

  return session;
});

/** The Jellyfin plugin over the process's HTTP client. */
export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const plugin: MigrationSourcePlugin = {
    source: "jellyfin",
    open: (target) =>
      openSession(target).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.withSpan("Jellyfin.open"),
      ),
  };

  return plugin;
});

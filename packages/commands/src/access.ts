import { v } from "convex/values";

import type { ContentDomain } from "./scopes.ts";

/** Grant levels, weakest first. Each level allows what the ones before it allow. */
export const levels = ["view", "edit", "manage"] as const;

interface ResourceTypeEntry {
  readonly table: string;
}

/**
 * Every resource type a grant can name, and the table that holds its rows. Only containers are
 * grantable: a library now, a playlist or a collection later. A title or a track has no grants of
 * its own; it is seen at its library's level.
 */
export const resourceTypes = {
  library: { table: "libraries" },
} as const satisfies Readonly<Record<string, ResourceTypeEntry>>;

const registered: ReadonlyArray<readonly [string, ResourceTypeEntry]> =
  Object.entries(resourceTypes);

/** A grant level as a Convex validator. */
export const level = v.union(...levels.map((name) => v.literal(name)));

/** A registered resource type's name as a Convex validator. */
export const resourceType = v.union(...registered.map(([type]) => v.literal(type)));

/** The id of a row of any registered resource type. */
export const resourceId = v.union(...registered.map(([, entry]) => v.id(entry.table)));

/** One grantable thing: its type, and the id of its row in that type's table. */
export const resourceRef = v.union(
  ...registered.map(([type, entry]) => v.object({ type: v.literal(type), id: v.id(entry.table) })),
);

interface DownloadKindEntry {
  readonly table: string;
  readonly serves: string;
}

/**
 * Every kind of domain item a device can keep for offline play, the table that holds its rows, and
 * what its download serves (ADR 0019). `file` is a movies media file, and `track` a music track.
 */
export const downloadKinds = {
  file: { table: "mediaFiles", serves: "file" },
  track: { table: "tracks", serves: "track" },
} as const satisfies Readonly<Record<string, DownloadKindEntry>>;

const downloadable: ReadonlyArray<readonly [string, DownloadKindEntry]> =
  Object.entries(downloadKinds);

/** One item a device can keep: its kind, and the id of its row in that kind's table. */
export const downloadItem = v.union(
  ...downloadable.map(([kind, entry]) =>
    v.object({ kind: v.literal(kind), id: v.id(entry.table) }),
  ),
);

/** What a download ticket names: a ticket resource kind some download kind serves, and an id. */
export const downloadResource = v.object({
  kind: v.union(
    ...[...new Set(downloadable.map(([, entry]) => entry.serves))].map((kind) => v.literal(kind)),
  ),
  id: v.string(),
});

/** A library's id, which the allowed-libraries restriction lists. */
export const libraryId = v.id("libraries");

interface ItemTypeEntry {
  readonly domain: ContentDomain;
  readonly table: string;
}

/**
 * Every type of item a group session can hold, the domain it belongs to, and the table of its
 * rows: the one list of item types (ADR 0017). The item validators derive from it, and the core's
 * item loaders fail to compile until a new type has one. A movies `title` is a movie or a show,
 * an `episode` one episode of a show, and a `file` one version of either. A music `track` is one
 * song, and an `album` the songs filed under it.
 */
export const itemTypes = {
  title: { domain: "movies", table: "titles" },
  episode: { domain: "movies", table: "episodes" },
  file: { domain: "movies", table: "mediaFiles" },
  track: { domain: "music", table: "tracks" },
  album: { domain: "music", table: "albums" },
} as const satisfies Readonly<Record<string, ItemTypeEntry>>;

const registeredItems: ReadonlyArray<readonly [string, ItemTypeEntry]> = Object.entries(itemTypes);

const itemRefOf = ([type, entry]: readonly [string, ItemTypeEntry]) =>
  v.object({ type: v.literal(type), id: v.id(entry.table) });

const itemDomains = [...new Set(registeredItems.map(([, entry]) => entry.domain))];

/**
 * An item with the domain it belongs to. Each domain pairs only with its own item types, so an
 * item of another domain fails the type check, the argument check, and the schema alike.
 */
export const domainItem = v.union(
  ...itemDomains.map((domain) =>
    v.object({
      domain: v.literal(domain),
      ref: v.union(
        ...registeredItems.flatMap((item) => (item[1].domain === domain ? [itemRefOf(item)] : [])),
      ),
    }),
  ),
);

/** Who a grant reaches: one user, a group's members, or every person on the server but guests. */
export const grantPrincipal = v.union(
  v.object({ kind: v.literal("user"), userId: v.id("users") }),
  v.object({ kind: v.literal("group"), groupId: v.id("groups") }),
  v.object({ kind: v.literal("household") }),
);

/** A kid's limits (ADR 0005). An admin sets them on a member; nobody sets their own. */
export const restrictions = v.object({
  /** The highest minimum viewer age a movie may carry, 0 to 21 (PG is 7); null means no cap. */
  maxMovieAge: v.union(v.number(), v.null()),
  hideUnrated: v.boolean(),
  hideExplicitMusic: v.boolean(),
  /** The libraries this person may use; null means every library their grants reach. */
  libraries: v.union(v.array(libraryId), v.null()),
});

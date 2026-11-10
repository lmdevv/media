import { v } from "convex/values";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { FOLDERS_MAX, isPlainPath } from "./folders";
import { cancel } from "./jobs/queue";
import { inOrder } from "./lib/inOrder";
import { sha256Hex } from "./lib/sha256";

/** What claims write: the database, and the scheduler for rescans and continuations. */
type ClaimCtx = Pick<MutationCtx, "db" | "scheduler">;

/** Most identities in one folder's chain: the folder and each parent up to `/`. */
const CHAIN_MAX = 64;

const CHAIN_ID_CHARS_MAX = 48;

const CHAIN_ID = /^[0-9]+:[0-9]+$/u;

const BOOT_ID_CHARS_MAX = 64;

const SOURCE_PATH_CHARS_MAX = 4096;

const SOURCE_SEGMENTS_MAX = 64;

/** Most keys one folder holds: its identity chain and its source path. */
const KEYS_PER_FOLDER_MAX = CHAIN_MAX + 1;

/** Hex digits of SHA-256 that stand for one part of a source path in its key. */
const SEGMENT_HASH_CHARS = 16;

/**
 * Other libraries' rows one range of `by_key_depth` reads past the library's own. A range that
 * fills it may hold more, which a continuation reads.
 */
const OVERLAP_PAGE = 4;

/** Most younger claims one call evicts; a continuation evicts the rest. */
const EVICT_MAX = 4;

/** Most libraries one refusal records as waiting on. */
const WAITS_RECORDED_MAX = 16;

/** Most libraries kept waiting on one owner, and most owners one library waits on. */
const WAITS_MAX = 64;

/** Most waiting libraries one call of `takeWaiters` hands over. */
const WAKE_PAGE = 16;

/** Where the server found a folder: its mount's device and its path within that filesystem. */
interface FolderSource {
  readonly device: string;
  readonly path: string;
}

/** One folder of a library as the server read it on disk. */
interface SentFolder {
  readonly folder: string;
  /** The `<dev>:<ino>` identities of the folder's real path and each parent, itself first. */
  readonly chain: ReadonlyArray<string>;
  /** Null when the server has no mount table. */
  readonly source: FolderSource | null;
}

/** The keys of an identity chain: the folder's own first, then each parent's up to `/`. */
type KeyChain = readonly [self: string, ...parents: ReadonlyArray<string>];

/** A folder's keys as `parseClaim` checked them. */
interface CheckedFolder {
  readonly folder: string;
  /** `i:<dev>:<ino>` of the folder's real path and of each parent, itself first. */
  readonly identities: KeyChain;
  /** The `s:` key of its source path (`sourceKey`), or null without a mount table. */
  readonly source: string | null;
}

/**
 * Whether the library now holds its folders, or the first of them another claim reaches and
 * whether the library is rescanned on its own once that claim goes.
 */
type FolderClaim =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly folder: string; readonly rescans: boolean };

const isDeviceId = (id: string): boolean => id.length <= CHAIN_ID_CHARS_MAX && CHAIN_ID.test(id);

const isSourcePath = (path: string): boolean =>
  path.length <= SOURCE_PATH_CHARS_MAX &&
  (path === "/" || (isPlainPath(path) && path.split("/").length - 1 <= SOURCE_SEGMENTS_MAX));

const keyChainOf = (keys: ReadonlyArray<string>): KeyChain | null => {
  const [self, ...parents] = keys;

  return self === undefined ? null : [self, ...parents];
};

/**
 * A source path as one key, `s:<device>:/<part>/<part>/`, each part 16 hex digits of its SHA-256
 * and `/` alone for the filesystem's root. A folder's key starts with another's exactly when its
 * source lies at or inside the other's on the same device, by whole parts, and stays at most
 * about 1,100 characters however long the path is.
 */
const sourceKey = ({ device, path }: FolderSource): string => {
  const parts = path === "/" ? [] : path.split("/").slice(1);

  return `s:${device}:/${parts.map((part) => `${sha256Hex(part).slice(0, SEGMENT_HASH_CHARS)}/`).join("")}`;
};

/** The keys of the source paths that hold a source key's path, `/` first. */
const sourceParents = (key: string): ReadonlyArray<string> => {
  const root = key.slice(0, key.indexOf("/") + 1);

  const parts = key
    .slice(root.length, -1)
    .split("/")
    .filter((part) => part !== "");

  return parts.map(
    (_part, n) =>
      `${root}${parts
        .slice(0, n)
        .map((part) => `${part}/`)
        .join("")}`,
  );
};

/** The end of the range of keys that start with a source key: its last `/` raised by one. */
const sourceRangeEnd = (key: string): string => `${key.slice(0, -1)}0`;

const checkedFolder = ({ folder, chain, source }: SentFolder): CheckedFolder => {
  const identities = keyChainOf(chain.map((id) => `i:${id}`));

  if (identities === null || chain.length > CHAIN_MAX || !chain.every(isDeviceId)) {
    throw new Error(
      `${folder} needs 1 to ${CHAIN_MAX} identities as <dev>:<ino>; got ${JSON.stringify(chain)}`,
    );
  }

  if (source === null) return { folder, identities, source: null };

  if (!isDeviceId(source.device) || !isSourcePath(source.path)) {
    throw new Error(
      `${folder} needs a source device as <major>:<minor> and an absolute path of at most ${SOURCE_SEGMENTS_MAX} parts; got ${JSON.stringify(source).slice(0, 256)}`,
    );
  }

  return { folder, identities, source: sourceKey(source) };
};

/**
 * The sent folders in the order of the library's folders, one for each, as keys.
 *
 * @throws Error when more than 16 are sent, a folder is not one of the library's, one of them is
 * missing or sent twice, a chain holds no identity or more than 64, an identity is not
 * `<dev>:<ino>` of at most 48 characters, a source's device is not `<major>:<minor>` of at most 48
 * characters or its path is not absolute and plain with at most 4,096 characters and 64 parts, or
 * the boot id is empty or longer than 64 characters: each a defect in the server, which sends what
 * `target` answered.
 */
export const parseClaim = (
  folders: ReadonlyArray<string>,
  bootId: string | null,
  sent: ReadonlyArray<SentFolder>,
): ReadonlyArray<CheckedFolder> => {
  if (sent.length > FOLDERS_MAX) {
    throw new Error(`A claim sends at most ${FOLDERS_MAX} folders; got ${sent.length}`);
  }

  if (bootId !== null && (bootId.length === 0 || bootId.length > BOOT_ID_CHARS_MAX)) {
    throw new Error(`A boot id has 1 to ${BOOT_ID_CHARS_MAX} characters`);
  }

  const stranger = sent.find((entry) => !folders.includes(entry.folder));

  if (stranger !== undefined) throw new Error(`${stranger.folder} is not a folder of the library`);

  return folders.map((folder) => {
    const matching = sent.filter((entry) => entry.folder === folder);
    const [only] = matching;

    if (only === undefined || matching.length > 1) {
      throw new Error(
        `A claim sends each folder of the library once; ${folder} came ${matching.length} times`,
      );
    }

    return checkedFolder(only);
  });
};

/**
 * Whether `inner` is `outer` or lies inside it: the identity chain of `inner` holds the identity of
 * `outer`, or the source of `inner` lies at or inside the source of `outer`.
 */
const reaches = (inner: CheckedFolder, outer: CheckedFolder): boolean =>
  inner.identities.includes(outer.identities[0]) ||
  (inner.source !== null && outer.source !== null && inner.source.startsWith(outer.source));

const overlap = (left: CheckedFolder, right: CheckedFolder): boolean =>
  reaches(left, right) || reaches(right, left);

/** One stored claim of the library and its key rows. */
interface Stored {
  readonly claim: Doc<"folderClaims">;
  readonly keys: ReadonlyArray<Doc<"folderClaimKeys">>;
}

const keyRowsOf = (db: DatabaseReader, claimId: Id<"folderClaims">) =>
  db
    .query("folderClaimKeys")
    .withIndex("by_claim", (q) => q.eq("claimId", claimId))
    .take(KEYS_PER_FOLDER_MAX);

/** The library's claims, at most 16, one per folder it holds, and their rows, at most 1,040. */
const storedOf = async (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
): Promise<ReadonlyArray<Stored>> => {
  const claims = await db
    .query("folderClaims")
    .withIndex("by_library_folder", (q) => q.eq("libraryId", libraryId))
    .take(FOLDERS_MAX);

  return Promise.all(
    claims.map(async (claim) => ({ claim, keys: await keyRowsOf(db, claim._id) })),
  );
};

const tally = (keys: ReadonlyArray<string>): ReadonlyMap<string, number> =>
  keys.reduce(
    (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1),
    new Map<string, number>(),
  );

/** The library's own rows that a range of `by_key_depth` may read, so it reads past them. */
interface OwnRows {
  readonly anyDepth: ReadonlyMap<string, number>;
  readonly folderItself: ReadonlyMap<string, number>;
  readonly sources: ReadonlyArray<string>;
}

const ownRowsOf = (stored: ReadonlyArray<Stored>): OwnRows => {
  const rows = stored.flatMap(({ keys }) => keys);

  return {
    anyDepth: tally(rows.map((row) => row.key)),
    folderItself: tally(rows.flatMap((row) => (row.depth === 0 ? [row.key] : []))),
    sources: rows.flatMap((row) => (row.key.startsWith("s:") ? [row.key] : [])),
  };
};

/** Other libraries' rows that one range read, and whether it filled its page. */
interface Found {
  readonly rows: ReadonlyArray<Doc<"folderClaimKeys">>;
  readonly full: boolean;
}

/** How a range of `by_key_depth` reads one key. */
type Reach =
  /** Rows of the key at any depth: identity chains that hold it, so folders at or inside it. */
  | "chains"
  /** Rows of the key at depth 0: the folder that is it, so one that holds the folder. */
  | "itself"
  /** Source keys that start with it: sources at or inside it. */
  | "inside";

/**
 * The overlap reads of one library, each range of `by_key_depth` read once, each reading at most
 * 4 rows past the library's own.
 */
const overlapReader = (db: DatabaseReader, libraryId: Id<"libraries">, own: OwnRows) => {
  const ranges = new Map<string, Promise<Found>>();

  const ownIn = (key: string, reach: Reach): number => {
    if (reach === "inside") return own.sources.filter((source) => source.startsWith(key)).length;

    return (reach === "itself" ? own.folderItself : own.anyDepth).get(key) ?? 0;
  };

  const range = (key: string, reach: Reach): Promise<Found> => {
    const id = `${reach}:${key}`;
    const known = ranges.get(id);

    if (known !== undefined) return known;

    const limit = ownIn(key, reach) + OVERLAP_PAGE;

    const found = db
      .query("folderClaimKeys")
      .withIndex("by_key_depth", (q) => {
        if (reach === "inside") return q.gte("key", key).lt("key", sourceRangeEnd(key));

        return reach === "itself" ? q.eq("key", key).eq("depth", 0) : q.eq("key", key);
      })
      .take(limit)
      .then((rows) => ({
        rows: rows.filter((row) => row.libraryId !== libraryId),
        full: rows.length === limit,
      }));

    ranges.set(id, found);

    return found;
  };

  /**
   * Other libraries' rows whose folders are `folder`, lie inside it, or hold it: at most 64
   * ranges for its identities and 65 for its source.
   */
  return async (folder: CheckedFolder): Promise<Found> => {
    const [self, ...parents] = folder.identities;
    const { source } = folder;

    const found = await Promise.all([
      range(self, "chains"),
      ...parents.map(async (parent) => range(parent, "itself")),
      ...(source === null
        ? []
        : [
            range(source, "inside"),
            ...sourceParents(source).map(async (parent) => range(parent, "itself")),
          ]),
    ]);

    return { rows: found.flatMap((each) => each.rows), full: found.some((each) => each.full) };
  };
};

/** Which of two claims came first: the earlier `since`, and the lower id on a tie. */
interface Rank {
  readonly since: number;
  /** Null for a folder the library claims for the first time, which loses a tie. */
  readonly claimId: Id<"folderClaims"> | null;
}

const isOlder = (row: Pick<Doc<"folderClaimKeys">, "since" | "claimId">, than: Rank): boolean =>
  row.since < than.since ||
  (row.since === than.since && (than.claimId === null || row.claimId < than.claimId));

/** What overlaps one folder: the libraries whose claims came first, and the younger claims. */
interface Contest {
  readonly older: ReadonlyArray<Id<"libraries">>;
  readonly younger: ReadonlyMap<Id<"folderClaims">, Id<"libraries">>;
  readonly full: boolean;
}

const contestOf = (found: Found, rank: Rank): Contest => ({
  older: [...new Set(found.rows.filter((row) => isOlder(row, rank)).map((row) => row.libraryId))],
  younger: new Map(
    found.rows.flatMap((row) =>
      isOlder(row, rank) ? [] : [[row.claimId, row.libraryId] as const],
    ),
  ),
  full: found.full,
});

const wake = async (ctx: ClaimCtx, ownerLibraryId: Id<"libraries">): Promise<void> => {
  await ctx.scheduler.runAfter(0, internal.core.libraries.wakeWaiting, { ownerLibraryId });
};

/**
 * Records that `libraryId` was refused a folder `ownerLibraryId` holds, once, so the owner's
 * letting go rescans it, and says whether that record exists now. A full list on either side
 * records nothing: that library is then rescanned by hand.
 */
const recordWait = async (
  ctx: ClaimCtx,
  libraryId: Id<"libraries">,
  ownerLibraryId: Id<"libraries">,
): Promise<boolean> => {
  const [known, waiters, owners] = await Promise.all([
    ctx.db
      .query("folderClaimWaits")
      .withIndex("by_owner_library", (q) =>
        q.eq("ownerLibraryId", ownerLibraryId).eq("libraryId", libraryId),
      )
      .first(),
    ctx.db
      .query("folderClaimWaits")
      .withIndex("by_owner_library", (q) => q.eq("ownerLibraryId", ownerLibraryId))
      .take(WAITS_MAX),
    ctx.db
      .query("folderClaimWaits")
      .withIndex("by_library", (q) => q.eq("libraryId", libraryId))
      .take(WAITS_MAX),
  ]);

  if (known !== null) return true;

  if (waiters.length >= WAITS_MAX || owners.length >= WAITS_MAX) return false;

  await ctx.db.insert("folderClaimWaits", { libraryId, ownerLibraryId });

  return true;
};

/** Records `libraryId` as waiting on each of `owners`, and says whether it waits on all of them. */
const recordWaits = async (
  ctx: ClaimCtx,
  libraryId: Id<"libraries">,
  owners: ReadonlyArray<Id<"libraries">>,
): Promise<boolean> => {
  const recorded = await inOrder(owners.slice(0, WAITS_RECORDED_MAX), async (owner) =>
    recordWait(ctx, libraryId, owner),
  );

  return owners.length <= WAITS_RECORDED_MAX && recorded.every(Boolean);
};

/** Deletes one claim and its rows, at most 65, and says whether it was still there. */
const deleteClaim = async (ctx: ClaimCtx, claimId: Id<"folderClaims">): Promise<boolean> => {
  const [claim, keys] = await Promise.all([ctx.db.get(claimId), keyRowsOf(ctx.db, claimId)]);

  await Promise.all(keys.map((row) => ctx.db.delete(row._id)));

  if (claim === null) return false;

  await ctx.db.delete(claim._id);

  return true;
};

/**
 * Takes one claim from its library: deletes its rows, at most 65, and marks it lost, so the
 * library owns the folder no more while it stays configured. Says whether it held the folder.
 */
const loseClaim = async (ctx: ClaimCtx, claimId: Id<"folderClaims">): Promise<boolean> => {
  const [claim, keys] = await Promise.all([ctx.db.get(claimId), keyRowsOf(ctx.db, claimId)]);

  await Promise.all(keys.map((row) => ctx.db.delete(row._id)));

  if (claim === null || claim.lost) return false;

  await ctx.db.patch(claim._id, { lost: true });

  return true;
};

/**
 * What follows a library losing a folder: its running scan is canceled, so it writes nothing
 * more and does not finish as if it had scanned; its purge is scheduled, which deletes its rows
 * in folders it lost; and the libraries waiting on it are rescanned, since it let a claim go.
 */
const disown = async (ctx: ClaimCtx, libraryId: Id<"libraries">): Promise<void> => {
  const library = await ctx.db.get(libraryId);

  if (library === null) return;

  const scan = library.lastScan === null ? null : await ctx.db.get(library.lastScan);

  if (scan?.status === "running") await cancel(ctx, scan._id);

  await ctx.scheduler.runAfter(0, internal.core.scans.purgeLibrary, { libraryId });
  await wake(ctx, libraryId);
};

/**
 * Takes up to 4 younger claims that overlap the library's from their libraries, records each
 * one's library as waiting on this one, disowns it, and says whether more are left.
 */
const evictYounger = async (
  ctx: ClaimCtx,
  libraryId: Id<"libraries">,
  younger: ReadonlyMap<Id<"folderClaims">, Id<"libraries">>,
): Promise<boolean> => {
  const evicting = [...younger].slice(0, EVICT_MAX);

  const evicted = await Promise.all(
    evicting.map(async ([claimId, owner]) => ((await loseClaim(ctx, claimId)) ? [owner] : [])),
  );

  const losers = [...new Set(evicted.flat())];

  await inOrder(losers, async (loser) => {
    await recordWait(ctx, loser, libraryId);
    await disown(ctx, loser);
  });

  return younger.size > EVICT_MAX;
};

const rowKey = (row: Pick<Doc<"folderClaimKeys">, "key" | "depth">): string =>
  JSON.stringify([row.key, row.depth]);

const sameKeys = (
  stored: ReadonlyArray<Doc<"folderClaimKeys">>,
  wanted: ReadonlyArray<Pick<Doc<"folderClaimKeys">, "key" | "depth">>,
): boolean => {
  const storedKeys = tally(stored.map(rowKey));
  const wantedKeys = tally(wanted.map(rowKey));

  return (
    storedKeys.size === wantedKeys.size &&
    [...wantedKeys].every(([key, count]) => storedKeys.get(key) === count)
  );
};

const keysOf = (folder: CheckedFolder) => [
  ...folder.identities.map((key, depth) => ({ key, depth })),
  ...(folder.source === null ? [] : [{ key: folder.source, depth: 0 }]),
];

/**
 * Writes the library's claim of one folder: a new claim from now, the one it lost claimed again
 * from now, or the one it holds with its `since` kept, its rows replaced when they changed. Says
 * whether rows it held were replaced.
 */
const writeClaim = async (
  ctx: ClaimCtx,
  libraryId: Id<"libraries">,
  bootId: string | null,
  folder: CheckedFolder,
  held: Stored | undefined,
  now: number,
): Promise<boolean> => {
  const wanted = keysOf(folder);

  if (held === undefined) {
    const claimId = await ctx.db.insert("folderClaims", {
      libraryId,
      folder: folder.folder,
      since: now,
      bootId,
      lost: false,
    });

    await Promise.all(
      wanted.map((row) =>
        ctx.db.insert("folderClaimKeys", { claimId, libraryId, since: now, ...row }),
      ),
    );

    return false;
  }

  const { claim } = held;

  if (claim.lost) {
    await ctx.db.patch(claim._id, { since: now, bootId, lost: false });
    await Promise.all(
      wanted.map((row) =>
        ctx.db.insert("folderClaimKeys", { claimId: claim._id, libraryId, since: now, ...row }),
      ),
    );

    return false;
  }

  if (claim.bootId !== bootId) await ctx.db.patch(claim._id, { bootId });

  if (sameKeys(held.keys, wanted)) return false;

  await Promise.all(held.keys.map((row) => ctx.db.delete(row._id)));
  await Promise.all(
    wanted.map((row) =>
      ctx.db.insert("folderClaimKeys", {
        claimId: claim._id,
        libraryId,
        since: claim.since,
        ...row,
      }),
    ),
  );

  return true;
};

const firstContested = async (
  remaining: ReadonlyArray<CheckedFolder>,
  contest: (folder: CheckedFolder) => Promise<Contest>,
  settled: ReadonlyArray<Contest> = [],
): Promise<
  | { readonly refused: CheckedFolder; readonly older: ReadonlyArray<Id<"libraries">> }
  | { readonly refused: null; readonly contests: ReadonlyArray<Contest> }
> => {
  const [first, ...rest] = remaining;

  if (first === undefined) return { refused: null, contests: settled };

  const found = await contest(first);

  return found.older.length > 0
    ? { refused: first, older: found.older }
    : firstContested(rest, contest, [...settled, found]);
};

const mergeYounger = (
  contests: ReadonlyArray<Contest>,
): ReadonlyMap<Id<"folderClaims">, Id<"libraries">> =>
  new Map(contests.flatMap((contest) => [...contest.younger]));

/**
 * Claims the library's folders by identity and source path (ADR 0024, "Folder identity"). A
 * folder that another of the library's folders reaches is refused. A folder that another
 * library's claim reaches, inside or out, goes to the claim that came first, whatever boot either
 * was read in: an older claim refuses this one, naming the first such folder in path order, and
 * the call then writes only the record that this library waits on the older claims' libraries,
 * and `rescans` says whether that record exists for each of them; younger claims are taken from
 * their libraries (`loseClaim`), which then wait on this one and are disowned (`disown`). Otherwise its claims become
 * `folders`, each folder keeping the time it was first claimed, and an unchanged claim writes
 * nothing. Replacing rows it held, or dropping a folder it no longer has, rescans the libraries
 * waiting on it.
 *
 * Bounded at the largest claim, 16 folders of 64 identities and a 64-part source path: at most
 * 17 ranges and 1,040 rows of its own, at most 2,064 ranges of `by_key_depth` that each read at
 * most 4 rows past its own, at most 1,040 deletes and 1,040 inserts of its rows, and at most 4
 * evictions of 2 reads and 66 deletes each. Convex counts a delete among its 4,096 reads, so that
 * is at most about 3,400. A range that fills its page, or more younger claims, schedule `settle`.
 * Convex serializes two concurrent claims that overlap: each reads a range the other writes into.
 */
export const claimIdentities = async (
  ctx: ClaimCtx,
  libraryId: Id<"libraries">,
  bootId: string | null,
  folders: ReadonlyArray<CheckedFolder>,
): Promise<FolderClaim> => {
  const twice = folders.find((folder) =>
    folders.some((other) => other !== folder && overlap(folder, other)),
  );

  if (twice !== undefined) return { claimed: false, folder: twice.folder, rescans: false };

  const now = Date.now();
  const stored = await storedOf(ctx.db, libraryId);
  const read = overlapReader(ctx.db, libraryId, ownRowsOf(stored));

  const heldOf = (folder: CheckedFolder) =>
    stored.find((each) => each.claim.folder === folder.folder);

  const rankOf = (folder: CheckedFolder): Rank => {
    const held = heldOf(folder)?.claim;

    return held === undefined || held.lost
      ? { since: now, claimId: null }
      : { since: held.since, claimId: held._id };
  };

  const contested = await firstContested(folders, async (folder) =>
    contestOf(await read(folder), rankOf(folder)),
  );

  if (contested.refused !== null) {
    const rescans = await recordWaits(ctx, libraryId, contested.older);

    return { claimed: false, folder: contested.refused.folder, rescans };
  }

  const replaced = await Promise.all(
    folders.map(async (folder) => writeClaim(ctx, libraryId, bootId, folder, heldOf(folder), now)),
  );

  const dropped = await Promise.all(
    stored
      .filter((each) => !folders.some((folder) => folder.folder === each.claim.folder))
      .map(async (each) => deleteClaim(ctx, each.claim._id)),
  );

  if ([...replaced, ...dropped].some(Boolean)) await wake(ctx, libraryId);

  const more = await evictYounger(ctx, libraryId, mergeYounger(contested.contests));

  if (more || contested.contests.some((contest) => contest.full)) {
    await ctx.scheduler.runAfter(0, internal.core.folderClaims.settle, { libraryId });
  }

  return { claimed: true };
};

/** A stored claim's folder and keys, or null for one that has no identity, which no claim writes. */
const checkedOf = ({ claim, keys }: Stored): CheckedFolder | null => {
  const identities = keyChainOf(
    keys
      .filter((row) => row.key.startsWith("i:"))
      .toSorted((left, right) => left.depth - right.depth)
      .map((row) => row.key),
  );

  const source = keys.find((row) => row.key.startsWith("s:"))?.key ?? null;

  return identities === null ? null : { folder: claim.folder, identities, source };
};

/**
 * Goes on with a claim whose overlap reads filled a page or that left younger claims: reads the
 * library's claims again and takes the younger claim of each overlapping pair from its library,
 * its own claim of a folder included, recording each loser as waiting on the winner and
 * disowning it. It schedules itself again while
 * a page fills or younger claims are left. Each pass evicts at least one claim while one fills,
 * so it ends. Bounded as `claimIdentities`.
 */
export const settle = internalMutation({
  args: { libraryId: v.id("libraries") },
  returns: v.null(),
  handler: async (ctx, { libraryId }) => {
    const stored = (await storedOf(ctx.db, libraryId)).filter((each) => !each.claim.lost);
    const read = overlapReader(ctx.db, libraryId, ownRowsOf(stored));

    const contests = await Promise.all(
      stored.flatMap((each) => {
        const folder = checkedOf(each);

        return folder === null
          ? []
          : [
              (async () => ({
                each,
                contest: contestOf(await read(folder), {
                  since: each.claim.since,
                  claimId: each.claim._id,
                }),
              }))(),
            ];
      }),
    );

    const lost = contests.filter(({ contest }) => contest.older.length > 0);

    await Promise.all(lost.map(async ({ each }) => loseClaim(ctx, each.claim._id)));
    await recordWaits(ctx, libraryId, [...new Set(lost.flatMap(({ contest }) => contest.older))]);

    if (lost.length > 0) await disown(ctx, libraryId);

    const kept = contests.filter(({ contest }) => contest.older.length === 0);

    const more = await evictYounger(
      ctx,
      libraryId,
      mergeYounger(kept.map(({ contest }) => contest)),
    );

    if (more || kept.some(({ contest }) => contest.full)) {
      await ctx.scheduler.runAfter(0, internal.core.folderClaims.settle, { libraryId });
    }

    return null;
  },
});

/**
 * Deletes the library's claims of `folders`, or of every folder when null, at most 16 claims of
 * 65 rows, and rescans the libraries waiting on it when one went. A library being deleted also
 * drops its own waits, at most 64. Its next scan claims its folders again.
 */
export const releaseClaims = async (
  ctx: ClaimCtx,
  libraryId: Id<"libraries">,
  folders: ReadonlyArray<string> | null,
): Promise<void> => {
  const stored = await storedOf(ctx.db, libraryId);
  const going = stored.filter((each) => folders === null || folders.includes(each.claim.folder));
  const deleted = await Promise.all(going.map(async (each) => deleteClaim(ctx, each.claim._id)));

  if (deleted.some(Boolean)) await wake(ctx, libraryId);

  if (folders !== null) return;

  const waits = await ctx.db
    .query("folderClaimWaits")
    .withIndex("by_library", (q) => q.eq("libraryId", libraryId))
    .take(WAITS_MAX);

  await Promise.all(waits.map((row) => ctx.db.delete(row._id)));
};

/**
 * Hands over up to 16 libraries that wait on `ownerLibraryId`, deleting their waits, and says
 * whether more wait. The owner let a folder go, so each may claim now.
 */
export const takeWaiters = async (
  ctx: Pick<MutationCtx, "db">,
  ownerLibraryId: Id<"libraries">,
): Promise<{ readonly libraryIds: ReadonlyArray<Id<"libraries">>; readonly more: boolean }> => {
  const waits = await ctx.db
    .query("folderClaimWaits")
    .withIndex("by_owner_library", (q) => q.eq("ownerLibraryId", ownerLibraryId))
    .take(WAKE_PAGE);

  await Promise.all(waits.map((row) => ctx.db.delete(row._id)));

  return { libraryIds: waits.map((row) => row.libraryId), more: waits.length === WAKE_PAGE };
};

/** Which of a library's folders it owns now, and which it lost to an older claim. */
export interface Ownership {
  /** Whether the library holds a live claim of `folder`. */
  readonly owns: (folder: string) => boolean;
  /** Whether an older claim took `folder` from the library, which still has it configured. */
  readonly lost: (folder: string) => boolean;
}

/** The library's ownership of its folders: one range of at most 16 claims. */
export const ownershipOf = async (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
): Promise<Ownership> => {
  const claims = await db
    .query("folderClaims")
    .withIndex("by_library_folder", (q) => q.eq("libraryId", libraryId))
    .take(FOLDERS_MAX);

  return {
    owns: (folder) => claims.some((claim) => claim.folder === folder && !claim.lost),
    lost: (folder) => claims.some((claim) => claim.folder === folder && claim.lost),
  };
};

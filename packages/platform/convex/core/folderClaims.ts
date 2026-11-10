import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { FOLDERS_MAX } from "./folders";

/** Most identities in one folder's chain: the folder and each parent up to `/`. */
const CHAIN_MAX = 64;

const CHAIN_ID_CHARS_MAX = 48;

const CHAIN_ID = /^[0-9]+:[0-9]+$/u;

const BOOT_ID_CHARS_MAX = 64;

/** Most claim rows one library holds: 16 folders of 64 identities each. */
const CLAIM_ROWS_MAX = FOLDERS_MAX * CHAIN_MAX;

/** One folder of a library and the `<dev>:<ino>` identities of it and each parent, itself first. */
interface FolderChain {
  readonly folder: string;
  readonly chain: ReadonlyArray<string>;
}

/** A folder's chain as `parseChains` checked it: its own identity, then its parents'. */
interface CheckedChain extends FolderChain {
  readonly self: string;
}

/** Whether the library now holds its folders by identity, or the first of them another reaches. */
type FolderClaim =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly folder: string };

const isChainId = (id: string): boolean => id.length <= CHAIN_ID_CHARS_MAX && CHAIN_ID.test(id);

/**
 * The sent chains in the order of the library's folders, one for each.
 *
 * @throws Error when more than 16 are sent, a folder is not one of the library's, one of them is
 * missing or sent twice, a chain holds no identity or more than 64, or an identity is not
 * `<dev>:<ino>` of at most 48 characters, or the boot id is empty or longer than 64 characters:
 * each a defect in the server, which sends what `target` answered.
 */
export const parseChains = (
  folders: ReadonlyArray<string>,
  bootId: string | null,
  sent: ReadonlyArray<FolderChain>,
): ReadonlyArray<CheckedChain> => {
  if (sent.length > FOLDERS_MAX) {
    throw new Error(`A claim sends at most ${FOLDERS_MAX} folders; got ${sent.length}`);
  }

  if (bootId !== null && (bootId.length === 0 || bootId.length > BOOT_ID_CHARS_MAX)) {
    throw new Error(`A boot id has 1 to ${BOOT_ID_CHARS_MAX} characters`);
  }

  const stranger = sent.find((entry) => !folders.includes(entry.folder));

  if (stranger !== undefined) throw new Error(`${stranger.folder} is not a folder of the library`);

  const ordered = folders.map((folder) => {
    const matching = sent.filter((entry) => entry.folder === folder);
    const [only] = matching;

    if (only === undefined || matching.length > 1) {
      throw new Error(
        `A claim sends each folder of the library once; ${folder} came ${matching.length} times`,
      );
    }

    return only;
  });

  return ordered.map(({ folder, chain }) => {
    const [self] = chain;

    if (self === undefined || chain.length > CHAIN_MAX || !chain.every(isChainId)) {
      throw new Error(
        `${folder} needs 1 to ${CHAIN_MAX} identities as <dev>:<ino>; got ${JSON.stringify(chain)}`,
      );
    }

    return { folder, self, chain };
  });
};

const claimRows = (db: DatabaseReader, libraryId: Id<"libraries">) =>
  db
    .query("folderClaims")
    .withIndex("by_library", (q) => q.eq("libraryId", libraryId))
    .take(CLAIM_ROWS_MAX);

const tally = (keys: ReadonlyArray<string>): ReadonlyMap<string, number> =>
  keys.reduce(
    (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1),
    new Map<string, number>(),
  );

/** The library's rows of one boot that a range of `by_boot_chain` may read, so it reads past them. */
interface OwnRows {
  readonly anyDepth: ReadonlyMap<string, number>;
  readonly folderItself: ReadonlyMap<string, number>;
}

const ownRowsOf = (own: ReadonlyArray<Doc<"folderClaims">>, bootId: string | null): OwnRows => {
  const sameBoot = own.filter((row) => row.bootId === bootId);

  return {
    anyDepth: tally(sameBoot.map((row) => row.chainId)),
    folderItself: tally(sameBoot.flatMap((row) => (row.depth === 0 ? [row.chainId] : []))),
  };
};

/**
 * Whether another library of the boot claims `chainId`: anywhere in a chain, so its folder is that
 * folder or inside it, or, with `depth` 0, as a folder itself, so that folder holds it. It reads
 * past this library's own rows, at most 1,024, which the claim replaces.
 */
const otherClaims = async (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  bootId: string | null,
  chainId: string,
  depth: 0 | "any",
  own: OwnRows,
): Promise<boolean> => {
  const skip = (depth === 0 ? own.folderItself : own.anyDepth).get(chainId) ?? 0;

  const rows = await db
    .query("folderClaims")
    .withIndex("by_boot_chain", (q) =>
      depth === 0
        ? q.eq("bootId", bootId).eq("chainId", chainId).eq("depth", 0)
        : q.eq("bootId", bootId).eq("chainId", chainId),
    )
    .take(skip + 1);

  return rows.some((row) => row.libraryId !== libraryId);
};

/** Whether two folders of one library reach each other: one is the other, or lies inside it. */
const overlap = (left: CheckedChain, right: CheckedChain): boolean =>
  right.chain.includes(left.self) || left.chain.includes(right.self);

const rowKey = (row: Pick<Doc<"folderClaims">, "folder" | "bootId" | "chainId" | "depth">) =>
  JSON.stringify([row.folder, row.bootId, row.chainId, row.depth]);

const sameRows = (
  stored: ReadonlyArray<Doc<"folderClaims">>,
  wanted: ReadonlyArray<Pick<Doc<"folderClaims">, "folder" | "bootId" | "chainId" | "depth">>,
): boolean => {
  const storedKeys = tally(stored.map(rowKey));
  const wantedKeys = tally(wanted.map(rowKey));

  return (
    storedKeys.size === wantedKeys.size &&
    [...wantedKeys].every(([key, count]) => storedKeys.get(key) === count)
  );
};

/**
 * Claims the library's folders by identity (ADR 0024, "Folder identity"): refused, naming its
 * first folder in path order that another library's claim of the same boot reaches, or that
 * another of its own folders reaches, and then it writes nothing and its earlier claims stay.
 * Otherwise its claims become `chains`, and an unchanged claim writes nothing.
 *
 * Bounded at the largest claim, 16 folders of 64 identities: one range for the library's own rows
 * (at most 1,024), at most 16 + 1,024 ranges of `by_boot_chain`, and at most 1,024 deletes and
 * 1,024 inserts. Convex serializes two concurrent claims that overlap: each reads a range the
 * other writes into.
 */
export const claimIdentities = async (
  ctx: Pick<MutationCtx, "db">,
  libraryId: Id<"libraries">,
  bootId: string | null,
  chains: ReadonlyArray<CheckedChain>,
): Promise<FolderClaim> => {
  const stored = await claimRows(ctx.db, libraryId);
  const own = ownRowsOf(stored, bootId);
  const asFolder = new Map<string, Promise<boolean>>();

  const heldAsFolder = (chainId: string): Promise<boolean> => {
    const known = asFolder.get(chainId);

    if (known !== undefined) return known;

    const found = otherClaims(ctx.db, libraryId, bootId, chainId, 0, own);

    asFolder.set(chainId, found);

    return found;
  };

  const reached = async (entry: CheckedChain): Promise<boolean> => {
    if (chains.some((other) => other !== entry && overlap(entry, other))) return true;

    const found = await Promise.all([
      otherClaims(ctx.db, libraryId, bootId, entry.self, "any", own),
      ...[...new Set(entry.chain.slice(1))].map(heldAsFolder),
    ]);

    return found.some(Boolean);
  };

  const firstReached = async (
    remaining: ReadonlyArray<CheckedChain>,
  ): Promise<CheckedChain | null> => {
    const [first, ...rest] = remaining;

    if (first === undefined) return null;

    return (await reached(first)) ? first : firstReached(rest);
  };

  const refused = await firstReached(chains);

  if (refused !== null) return { claimed: false, folder: refused.folder };

  const wanted = chains.flatMap(({ folder, chain }) =>
    chain.map((chainId, depth) => ({ libraryId, folder, bootId, chainId, depth })),
  );

  if (sameRows(stored, wanted)) return { claimed: true };

  await Promise.all(stored.map((row) => ctx.db.delete(row._id)));
  await Promise.all(wanted.map((row) => ctx.db.insert("folderClaims", row)));

  return { claimed: true };
};

/**
 * Deletes every claim of a library whose folders changed or that is being deleted: at most 1,024
 * rows, so one mutation holds it. Its next scan claims its folders again.
 */
export const releaseClaims = async (
  ctx: Pick<MutationCtx, "db">,
  libraryId: Id<"libraries">,
): Promise<void> => {
  const rows = await claimRows(ctx.db, libraryId);

  await Promise.all(rows.map((row) => ctx.db.delete(row._id)));
};

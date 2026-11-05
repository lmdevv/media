import type { PaginationOptions, PaginationResult } from "convex/server";

import type { DownloadItem, Level } from "../../commands/access";
import { register } from "../../commands/core/downloads";
import type { DownloadQuality } from "../../commands/settings";
import type { ContentDomain } from "../../commands/scopes";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import type { Caller } from "./auth/caller";
import { NO_DEVICE } from "./devices/facts";
import { sourceOf } from "./downloadSources";
import type { DownloadSource, LibraryReader } from "./downloadSources";
import { deleteCounter, incrementCounter, readCounter } from "./lib/counters";
import { fail } from "./lib/errors";
import { paginate } from "./lib/paginate";
import { requireServer } from "./permissions/authorize";
import { levelOn } from "./permissions/grants";
import { can, contentNeeds, itemOf } from "./permissions/policy";
import type { Decision } from "./permissions/policy";
import { downloadQualityOf } from "./settings";
import { issuePersonalTicket } from "./tickets";

const DEFAULT_CAP_BYTES = 64_000_000_000;

const ITEMS_PER_DEVICE_MAX = 500;

const LIST_PAGE_MAX = 200;

const DOWNLOAD_TICKET_MS = 15 * 60 * 1000;

const ON_NO_DEVICE =
  "This session is on no device, so it keeps no downloads; register this app first";

const NOT_KEPT = "You keep no such item on this device";

const NO_ITEM = "No such item";

const bytesCounter = (deviceId: Id<"devices">): string => `downloadBytes:${deviceId}`;

const itemsCounter = (deviceId: Id<"devices">): string => `downloadItems:${deviceId}`;

type Kept =
  | { readonly state: "available"; readonly source: DownloadSource; readonly bytes: Bytes }
  | { readonly state: "expired"; readonly because: ExpiredBecause }
  | { readonly state: "gone" };

type Refused = Extract<Decision, { readonly allowed: false }>;

type ExpiredBecause = "access" | "restricted" | "device";

const expiredBecause = (refused: Refused): ExpiredBecause => {
  if (refused.because === "shared-device") return "device";

  return refused.because === "restricted" ? "restricted" : "access";
};

/** Whole bytes, as the device's totals count them. */
type Bytes = number;

/** What one call reads about each library: its row and the caller's level on it, once each. */
interface LibraryReads {
  readonly libraryOf: LibraryReader;
  readonly levelOf: (libraryId: Id<"libraries">) => Promise<Level | null>;
}

const once = <Key, Value>(load: (key: Key) => Promise<Value>): ((key: Key) => Promise<Value>) => {
  const loaded = new Map<Key, Promise<Value>>();

  return (key) => {
    const known = loaded.get(key) ?? load(key);

    loaded.set(key, known);

    return known;
  };
};

const libraryReads = (db: DatabaseReader, caller: Caller): LibraryReads => ({
  libraryOf: once(async (libraryId) => db.get(libraryId)),
  levelOf: once(async (libraryId) => levelOn(db, caller, { type: "library", id: libraryId })),
});

/** A domain's estimate at `quality`, rounded up to whole bytes. */
const bytesAt = (source: DownloadSource, quality: DownloadQuality): Bytes =>
  Math.ceil(source.bytes(quality));

const deviceOf = async (db: DatabaseReader, caller: Caller): Promise<Doc<"devices"> | null> =>
  caller.deviceId === null ? null : db.get(caller.deviceId);

const requireDevice = async (db: DatabaseReader, caller: Caller): Promise<Doc<"devices">> =>
  (await deviceOf(db, caller)) ?? fail("conflict", ON_NO_DEVICE);

interface Judged {
  readonly source: DownloadSource;
  readonly library: Doc<"libraries">;
  readonly decision: Decision;
}

/** An item and the caller's right to keep it on `device`; null when the item or its library is gone. */
const judge = async (
  db: DatabaseReader,
  caller: Caller,
  device: Doc<"devices"> | null,
  item: DownloadItem,
  reads: LibraryReads,
): Promise<Judged | null> => {
  const source = await sourceOf(db, item, reads.libraryOf);
  const library = source === null ? null : await reads.libraryOf(source.library);

  if (source === null || library === null) return null;

  const decision = can(caller, "keep", {
    on: "download",
    device: device?.mode ?? null,
    item: itemOf(library, await reads.levelOf(library._id), source.facts),
  });

  return { source, library, decision };
};

const keptOf = (judged: Judged | null, quality: DownloadQuality): Kept => {
  if (judged === null) return { state: "gone" };

  const { source, decision } = judged;

  return decision.allowed
    ? { state: "available", source, bytes: bytesAt(source, quality) }
    : { state: "expired", because: expiredBecause(decision) };
};

const refuseAdd = (decision: Refused, domain: ContentDomain): never => {
  if (decision.refusal === "hidden") return fail("not_found", NO_ITEM);

  if (decision.because === "guest") return fail("forbidden", "Guests cannot download");

  if (decision.because === "no-device") return fail("conflict", ON_NO_DEVICE);

  if (decision.because === "shared-device") {
    return fail("forbidden", "A shared device keeps no downloads");
  }

  return decision.because === "scope"
    ? fail("forbidden", `This session lacks the ${contentNeeds("play", domain).scope} scope`)
    : fail("forbidden", "You cannot download this");
};

const rowOf = (
  db: DatabaseReader,
  deviceId: Id<"devices">,
  userId: Id<"users">,
  item: DownloadItem,
): Promise<Doc<"downloads"> | null> =>
  db
    .query("downloads")
    .withIndex("by_device_user_item", (q) =>
      q
        .eq("deviceId", deviceId)
        .eq("userId", userId)
        .eq("item.kind", item.kind)
        .eq("item.id", item.id),
    )
    .unique();

const capRow = (db: DatabaseReader, deviceId: Id<"devices">): Promise<Doc<"downloadCaps"> | null> =>
  db
    .query("downloadCaps")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();

interface Usage {
  readonly bytes: number;
  readonly items: number;
  readonly capBytes: number;
}

const usageOf = async (db: DatabaseReader, deviceId: Id<"devices">): Promise<Usage> => {
  const [bytes, items, cap] = await Promise.all([
    readCounter(db, bytesCounter(deviceId)),
    readCounter(db, itemsCounter(deviceId)),
    capRow(db, deviceId),
  ]);

  return { bytes, items, capBytes: cap?.bytes ?? DEFAULT_CAP_BYTES };
};

const UNITS = ["KB", "MB", "GB", "TB"] as const;

const sizeOf = (bytes: Bytes): string => {
  if (bytes < 1000) return `${bytes} bytes`;

  const unit = UNITS.findIndex(
    (_, power) =>
      power === UNITS.length - 1 || Number((bytes / 1000 ** (power + 1)).toFixed(1)) < 1000,
  );

  return `${(bytes / 1000 ** (unit + 1)).toFixed(1)} ${UNITS[unit]}`;
};

const spaceRefusal = (usage: Usage, adding: number): string | null => {
  if (usage.items >= ITEMS_PER_DEVICE_MAX) {
    return `This device already keeps ${ITEMS_PER_DEVICE_MAX} downloads; remove one first`;
  }

  return usage.bytes + adding > usage.capBytes
    ? `Downloads on this device take ${sizeOf(usage.bytes)} of its ${sizeOf(usage.capBytes)} limit, and this one needs ${sizeOf(adding)}; remove some first`
    : null;
};

const moveCounter = async (db: MutationCtx["db"], name: string, delta: number): Promise<void> => {
  if (delta !== 0) await incrementCounter(db, name, delta);
};

/**
 * Deletes one page of a removed device's downloads, for the device registry's purge. The page that
 * finishes also deletes the device's totals and its limit. The device's sessions ended with it, so
 * nobody reads them meanwhile.
 */
export const purgeDevicePage = async (
  ctx: Pick<MutationCtx, "db">,
  deviceId: Id<"devices">,
  options: PaginationOptions,
): Promise<PaginationResult<Doc<"downloads">>> => {
  const page = await paginate(
    ctx.db,
    { table: "downloads", index: "by_device_user", range: (q) => q.eq("deviceId", deviceId) },
    options,
  );

  await Promise.all(page.page.map((row) => ctx.db.delete(row._id)));

  if (page.isDone) {
    const cap = await capRow(ctx.db, deviceId);

    await Promise.all([
      deleteCounter(ctx.db, bytesCounter(deviceId)),
      deleteCounter(ctx.db, itemsCounter(deviceId)),
      cap === null ? null : ctx.db.delete(cap._id),
    ]);
  }

  return page;
};

export const { add, list, fetch, remove, usage, setCap } = register({
  add: async (ctx, { item }, caller) => {
    const device = await deviceOf(ctx.db, caller);

    const judged =
      (await judge(ctx.db, caller, device, item, libraryReads(ctx.db, caller))) ??
      fail("not_found", NO_ITEM);

    const { decision } = judged;

    if (!decision.allowed) return refuseAdd(decision, judged.library.kind);

    if (device === null) throw new Error("can let a session on no device keep an item");

    const [existing, quality, used] = await Promise.all([
      rowOf(ctx.db, device._id, caller.userId, item),
      downloadQualityOf(ctx.db, device._id, caller.userId),
      usageOf(ctx.db, device._id),
    ]);

    if (existing !== null) return null;

    const bytes = bytesAt(judged.source, quality);
    const why = spaceRefusal(used, bytes);

    if (why !== null) return fail("conflict", why);

    await ctx.db.insert("downloads", {
      deviceId: device._id,
      userId: caller.userId,
      item,
      quality,
      reserved: { bytes, revision: judged.source.revision },
    });

    await moveCounter(ctx.db, bytesCounter(device._id), bytes);
    await moveCounter(ctx.db, itemsCounter(device._id), 1);

    return null;
  },
  list: async (ctx, { paginationOpts }, caller) => {
    const device = await requireDevice(ctx.db, caller);

    const page = await paginate(
      ctx.db,
      {
        table: "downloads",
        index: "by_device_user",
        range: (q) => q.eq("deviceId", device._id).eq("userId", caller.userId),
        order: "desc",
      },
      {
        ...paginationOpts,
        numItems: Math.min(paginationOpts.numItems, LIST_PAGE_MAX),
        maximumRowsRead: LIST_PAGE_MAX,
      },
    );

    const reads = libraryReads(ctx.db, caller);

    const entries = await Promise.all(
      page.page.map(async (row) => {
        const kept = keptOf(await judge(ctx.db, caller, device, row.item, reads), row.quality);

        if (kept.state !== "available") return { item: row.item, ...kept };

        return {
          item: row.item,
          state: kept.state,
          revision: kept.source.revision,
          quality: row.quality,
          bytes: kept.bytes,
          label: kept.source.label,
        };
      }),
    );

    return { ...page, page: entries };
  },
  fetch: async (ctx, { item }, caller) => {
    const device = await requireDevice(ctx.db, caller);

    const [row, judged] = await Promise.all([
      rowOf(ctx.db, device._id, caller.userId, item),
      judge(ctx.db, caller, device, item, libraryReads(ctx.db, caller)),
    ]);

    if (row === null) return fail("not_found", NOT_KEPT);

    const kept = keptOf(judged, row.quality);

    if (kept.state !== "available") return kept;

    const { source, bytes } = kept;
    const { reserved } = row;

    if (reserved.revision !== source.revision || reserved.bytes !== bytes) {
      await ctx.db.patch(row._id, { reserved: { bytes, revision: source.revision } });
      await moveCounter(ctx.db, bytesCounter(device._id), bytes - reserved.bytes);
    }

    const ticket = await issuePersonalTicket(ctx, caller, {
      resource: source.resource,
      purpose: "download",
      lifetimeMs: DOWNLOAD_TICKET_MS,
    });

    return {
      state: kept.state,
      revision: source.revision,
      quality: row.quality,
      bytes,
      resource: source.resource,
      ticket: ticket.ticket,
      expiresAt: ticket.expiresAt,
    };
  },
  remove: async (ctx, { item }, caller) => {
    const device = await requireDevice(ctx.db, caller);
    const row = await rowOf(ctx.db, device._id, caller.userId, item);

    if (row === null) return null;

    await ctx.db.delete(row._id);
    await moveCounter(ctx.db, bytesCounter(device._id), -row.reserved.bytes);
    await moveCounter(ctx.db, itemsCounter(device._id), -1);

    return null;
  },
  usage: async (ctx, _args, caller) => {
    const device = await requireDevice(ctx.db, caller);

    return { ...(await usageOf(ctx.db, device._id)), capItems: ITEMS_PER_DEVICE_MAX };
  },
  setCap: async (ctx, { deviceId, bytes }, caller) => {
    requireServer(caller, "manageDevices");

    if ((await ctx.db.get(deviceId)) === null) return fail("not_found", NO_DEVICE);

    const row = await capRow(ctx.db, deviceId);

    if (bytes === null) {
      if (row !== null) await ctx.db.delete(row._id);

      return null;
    }

    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return fail("invalid_args", "A download limit is a whole number of bytes, 0 or more");
    }

    if (row === null) await ctx.db.insert("downloadCaps", { deviceId, bytes });
    else await ctx.db.patch(row._id, { bytes });

    return null;
  },
});

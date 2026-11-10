import { Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { logMark, usageSince } from "../../admin";
import { member } from "../../devices";
import type { Member } from "../../devices";
import { runServer } from "../../service";
import { unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { eventually, retrying } from "../jobs/driver";
import { makeTree, removeTree } from "./files";
import { claimScanOf, scanCalls } from "./scanner";
import type { ScanLease } from "./scanner";

const stack = coreStackFromEnvFile();

const Claimed = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("held"),
    value: Schema.Union([
      Schema.Struct({ claimed: Schema.Literal(true) }),
      Schema.Struct({ claimed: Schema.Literal(false), folder: Schema.String }),
    ]),
  }),
  Schema.Struct({ outcome: Schema.Literals(["canceled", "lost"]) }),
]);

type Claim = (typeof Claimed.Type & { readonly outcome: "held" })["value"];

const roots: Array<string> = [];

afterAll(async () => {
  await Promise.all(roots.map(removeTree));
});

/** A music library on `count` new empty folders, in the path order `target` answers them. */
interface Library {
  readonly libraryId: Id<"libraries">;
  readonly folders: ReadonlyArray<string>;
}

const library = async (admin: Member, count = 1): Promise<Library> => {
  const made = await Promise.all(Array.from({ length: count }, async () => makeTree([])));

  roots.push(...made);

  const { libraryId } = await admin.signedIn.client.mutation(api.core.libraries.create, {
    name: `Claims ${unique()}`,
    kind: "music",
    folders: made,
  });

  return { libraryId, folders: made.toSorted() };
};

/** Holds a scan of the library: joins its queued scan or queues one, and claims it. */
const holdScan = async (core: CoreStack, admin: Member, of: Library): Promise<ScanLease> => {
  await admin.signedIn.client.mutation(api.core.libraries.scan, { libraryId: of.libraryId });

  return claimScanOf(scanCalls(core, `claims-${unique()}`), "music", of.libraryId);
};

/** Where the server found a folder: its mount's device and its path within that filesystem. */
interface Source {
  readonly device: string;
  readonly path: string;
}

/** One folder as the server reads it on disk; no source, as without a mount table, by default. */
interface Sent {
  readonly folder: string;
  readonly chain: ReadonlyArray<string>;
  readonly source?: Source;
}

const claimHeld = async (
  core: CoreStack,
  lease: ScanLease,
  bootId: string | null,
  folders: ReadonlyArray<Sent>,
): Promise<Claim> => {
  const answer = await retrying(() =>
    runServer(
      core,
      api.core.scans.claimFolders,
      {
        lease,
        kind: "music",
        bootId,
        folders: folders.map((entry) => ({
          folder: entry.folder,
          chain: [...entry.chain],
          source: entry.source ?? null,
        })),
      },
      Claimed,
    ),
  );

  if (answer.outcome !== "held") throw new Error(`claimFolders answered ${answer.outcome}`);

  return answer.value;
};

/** One scan of the library that claims its folders, in path order, as `read` gives them. */
const claimRead = async (
  core: CoreStack,
  admin: Member,
  of: Library,
  bootId: string | null,
  read: (folder: string, n: number) => Sent,
): Promise<Claim> => {
  const lease = await holdScan(core, admin, of);
  const answer = await claimHeld(core, lease, bootId, of.folders.map(read));

  await scanCalls(core, "claims-end").finish(lease);

  return answer;
};

/** One scan of the library that claims `chains`, its folders' in path order, and then ends. */
const claim = (
  core: CoreStack,
  admin: Member,
  of: Library,
  bootId: string | null,
  chains: ReadonlyArray<ReadonlyArray<string>>,
): Promise<Claim> =>
  claimRead(core, admin, of, bootId, (folder, n) => ({ folder, chain: chains[n] ?? [] }));

const ScanState = Schema.Struct({
  scan: Schema.NullOr(Schema.Struct({ jobId: Schema.String, status: Schema.String })),
});

const lastScanOf = async (admin: Member, of: Library) =>
  Schema.decodeSync(ScanState)(
    await admin.signedIn.client.query(api.core.libraries.get, { libraryId: of.libraryId }),
  ).scan;

const remove = (admin: Member, of: Library) =>
  admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId: of.libraryId });

/**
 * This run's device numbers start here. Claims outlive boots, so a claim a failed run left would
 * refuse a later run's claim of the same identities.
 */
const RUN_DEVICES = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);

/** A chain of identities on this run's device `dev`: the folder's inode first, then each parent's. */
const chain = (dev: number, ...inodes: ReadonlyArray<number>): ReadonlyArray<string> =>
  inodes.map((inode) => `${RUN_DEVICES + dev}:${inode}`);

/** This run's mount device `minor`, as `<major>:<minor>`. */
const mount = (minor: number): string => `${RUN_DEVICES}:${minor}`;

/** A folder read as `chainOf` and found at `path` on the mount of `device`. */
const sourced =
  (chainOf: ReadonlyArray<string>, device: string, path: string) =>
  (folder: string): Sent => ({ folder, chain: chainOf, source: { device, path } });

/**
 * The `n`th folder of the widest claim read on device `base`: every identity and source path
 * distinct, so the check reads a range for each of 64 identities, the deepest source path of 64
 * parts, and each of its parents up to `/`.
 */
const widestRead =
  (base: number) =>
  (folder: string, n: number): Sent => ({
    folder,
    chain: chain(base, ...Array.from({ length: 64 }, (_depth, depth) => n * 64 + depth)),
    source: {
      device: mount(base),
      path: `/f${n}${Array.from({ length: 63 }, (_part, part) => `/${"p".repeat(60)}${part}`).join("")}`,
    },
  });

describe.skipIf(stack === undefined)("folder identity claims", { timeout: 300_000 }, () => {
  it("refuse a folder another library's older claim reaches, inside or out, and write nothing", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "claims-admin", "admin");
    const boot = `boot-${unique()}`;

    const [films, linked, third] = [
      await library(admin),
      await library(admin),
      await library(admin),
    ];

    // `/` is 1, `/srv` is 10, and `films` is `/srv/a`, 100.
    expect(await claim(stack, admin, films, boot, [chain(9, 100, 10, 1)])).toEqual({
      claimed: true,
    });
    expect(await claim(stack, admin, linked, boot, [chain(9, 300, 10, 1)])).toEqual({
      claimed: true,
    });

    const [linkedFolder] = linked.folders;
    const refused = { claimed: false, folder: linkedFolder };

    // The same folder through a link, a folder inside it, and a folder that holds it.
    expect(await claim(stack, admin, linked, boot, [chain(9, 100, 10, 1)])).toEqual(refused);
    expect(await claim(stack, admin, linked, boot, [chain(9, 200, 100, 10, 1)])).toEqual(refused);
    expect(await claim(stack, admin, linked, boot, [chain(9, 10, 1)])).toEqual(refused);

    // Each refusal kept the earlier claim of `/srv/c`, 300.
    expect(await claim(stack, admin, third, boot, [chain(9, 300, 10, 1)])).toEqual({
      claimed: false,
      folder: third.folders[0],
    });

    // Another boot, or none, meets the same claims: ownership does not depend on the boot.
    expect(await claim(stack, admin, linked, `${boot}-next`, [chain(9, 100, 10, 1)])).toEqual(
      refused,
    );
    expect(await claim(stack, admin, third, null, [chain(9, 300, 10, 1)])).toEqual({
      claimed: false,
      folder: third.folders[0],
    });

    // A claim of its own folder under a new boot keeps it.
    expect(await claim(stack, admin, linked, `${boot}-next`, [chain(9, 300, 10, 1)])).toEqual({
      claimed: true,
    });

    await Promise.all([films, linked, third].map(async (each) => remove(admin, each)));
  });

  it("refuse one folder sent twice through a link, naming the first in path order", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "claims-self", "admin");
    const boot = `boot-${unique()}`;
    const twice = await library(admin, 2);

    expect(await claim(stack, admin, twice, boot, [chain(4, 50, 1), chain(4, 51, 50, 1)])).toEqual({
      claimed: false,
      folder: twice.folders[0],
    });
    expect(await claim(stack, admin, twice, boot, [chain(4, 50, 1), chain(4, 52, 1)])).toEqual({
      claimed: true,
    });

    await remove(admin, twice);
  });

  it("let another library take a folder once its claimer changes its folders or goes", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "claims-free", "admin");
    const boot = `boot-${unique()}`;
    const [first, second] = [await library(admin), await library(admin)];
    const shared = [chain(7, 70, 1)];

    expect(await claim(stack, admin, first, boot, shared)).toEqual({ claimed: true });
    expect(await claim(stack, admin, second, boot, shared)).toMatchObject({ claimed: false });

    const moved = await makeTree([]);

    roots.push(moved);
    await admin.signedIn.client.mutation(api.core.libraries.setFolders, {
      libraryId: first.libraryId,
      folders: [moved],
    });

    expect(await claim(stack, admin, second, boot, shared)).toEqual({ claimed: true });

    const back = { libraryId: first.libraryId, folders: [moved] };

    expect(await claim(stack, admin, back, boot, shared)).toMatchObject({ claimed: false });
    await remove(admin, second);
    expect(await claim(stack, admin, back, boot, shared)).toEqual({ claimed: true });

    await remove(admin, back);
  });

  it("keep a folder with its first claimer across a reboot, and rescan the refused library once it lets go", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "claims-reboot", "admin");
    const [owner, alias] = [await library(admin), await library(admin)];
    const same = [chain(6, 60, 6, 1)];
    const [boot, rebooted] = [`boot-${unique()}`, `boot-${unique()}`];

    expect(await claim(stack, admin, owner, boot, same)).toEqual({ claimed: true });
    expect(await claim(stack, admin, alias, boot, same)).toEqual({
      claimed: false,
      folder: alias.folders[0],
    });

    // After the reboot the alias scans first, and the owner's claim still holds it off.
    expect(await claim(stack, admin, alias, rebooted, same)).toEqual({
      claimed: false,
      folder: alias.folders[0],
    });
    expect(await claim(stack, admin, owner, rebooted, same)).toEqual({ claimed: true });

    const refusedScan = await lastScanOf(admin, alias);
    const moved = await makeTree([]);

    roots.push(moved);
    await admin.signedIn.client.mutation(api.core.libraries.setFolders, {
      libraryId: owner.libraryId,
      folders: [moved],
    });

    // The owner let the folder go, so the alias's scan is queued without anyone asking.
    const queued = await eventually("the waiting library's scan to be queued", async () => {
      const scan = await lastScanOf(admin, alias);

      return scan !== null && scan.jobId !== refusedScan?.jobId && scan.status === "queued"
        ? scan
        : null;
    });

    const lease = await claimScanOf(
      scanCalls(stack, `claims-${unique()}`),
      "music",
      alias.libraryId,
    );

    expect(lease.jobId).toBe(queued.jobId);
    expect(
      await claimHeld(stack, lease, rebooted, [
        { folder: alias.folders[0] ?? "", chain: same[0] ?? [] },
      ]),
    ).toEqual({ claimed: true });

    await scanCalls(stack, "claims-reboot-end").finish(lease);

    // The owner moving back now meets the alias's claim, which came first this time.
    const back = { libraryId: owner.libraryId, folders: [moved] };

    expect(await claim(stack, admin, back, rebooted, same)).toEqual({
      claimed: false,
      folder: moved,
    });

    await Promise.all([owner, alias].map(async (each) => remove(admin, each)));
  });

  it("refuse a bind mount of a folder inside another library's folder by its source path", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "claims-bind", "admin");
    const boot = `boot-${unique()}`;

    const [whole, bound, around, elsewhere, sibling] = [
      await library(admin),
      await library(admin),
      await library(admin),
      await library(admin),
      await library(admin),
    ];

    // `/lib/library` and a bind mount of `/lib/library/child`: the mount point's parents are not
    // `/lib/library`, so the two inode chains never meet.
    const chainA = chain(66307, 16155053, 16155052, 16154960, 15990785, 2);

    const chainB = chain(66307, 16155054, 16155052, 16154960, 15990785, 2);

    expect(
      await claimRead(stack, admin, whole, boot, sourced(chainA, mount(1), "/lib/library")),
    ).toEqual({ claimed: true });
    expect(
      await claimRead(stack, admin, bound, boot, sourced(chainB, mount(1), "/lib/library/child")),
    ).toEqual({ claimed: false, folder: bound.folders[0] });

    // A bind mount of a folder that holds it is refused the same way.
    expect(
      await claimRead(stack, admin, around, boot, sourced(chain(66307, 7001, 2), mount(1), "/lib")),
    ).toEqual({ claimed: false, folder: around.folders[0] });

    // The same path on another device, and a sibling whose name only starts the same, are apart.
    expect(
      await claimRead(
        stack,
        admin,
        elsewhere,
        boot,
        sourced(chain(66307, 7002, 2), mount(2), "/lib/library/child"),
      ),
    ).toEqual({ claimed: true });
    expect(
      await claimRead(
        stack,
        admin,
        sibling,
        boot,
        sourced(chain(66307, 7003, 2), mount(1), "/lib/library-two"),
      ),
    ).toEqual({ claimed: true });

    await Promise.all(
      [whole, bound, around, elsewhere, sibling].map(async (each) => remove(admin, each)),
    );
  });

  it("claim exactly one of two libraries that race for one folder", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "claims-race", "admin");
    const boot = `boot-${unique()}`;
    const [left, right] = [await library(admin), await library(admin)];
    const leftLease = await holdScan(stack, admin, left);
    const rightLease = await holdScan(stack, admin, right);

    const answers = await Promise.all([
      claimHeld(stack, leftLease, boot, [{ folder: left.folders[0] ?? "", chain: chain(5, 9, 1) }]),
      claimHeld(stack, rightLease, boot, [
        { folder: right.folders[0] ?? "", chain: chain(5, 8, 9, 1) },
      ]),
    ]);

    expect(answers.filter((answer) => answer.claimed).length).toBe(1);

    const calls = scanCalls(stack, "claims-race-end");

    await Promise.all([calls.finish(leftLease), calls.finish(rightLease)]);
    await Promise.all([left, right].map(async (each) => remove(admin, each)));
  });

  it("throw on folders other than the library's or a malformed chain, a server defect", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "claims-defect", "admin");
    const pair = await library(admin, 2);
    const lease = await holdScan(stack, admin, pair);
    const [first = "", second = ""] = pair.folders;
    const good = chain(3, 30, 1);

    const send = (folders: ReadonlyArray<Sent>) => claimHeld(stack, lease, null, folders);

    await expect(send([{ folder: first, chain: good }])).rejects.toThrow(/once/u);
    await expect(
      send([
        { folder: first, chain: good },
        { folder: second, chain: chain(3, 31, 1) },
        { folder: `${second}-not`, chain: good },
      ]),
    ).rejects.toThrow(/not a folder of the library/u);
    await expect(
      send([
        { folder: first, chain: ["3:30", "x"] },
        { folder: second, chain: good },
      ]),
    ).rejects.toThrow(/identities/u);
    await expect(
      send([
        { folder: first, chain: [] },
        { folder: second, chain: good },
      ]),
    ).rejects.toThrow(/identities/u);
    await expect(
      send([
        { folder: first, chain: chain(3, ...Array.from({ length: 65 }, (_, n) => n + 100)) },
        { folder: second, chain: good },
      ]),
    ).rejects.toThrow(/identities/u);
    await expect(
      send([
        { folder: first, chain: [`${"1".repeat(40)}:${"2".repeat(8)}`] },
        { folder: second, chain: good },
      ]),
    ).rejects.toThrow(/identities/u);

    const sendSource = (source: Source) =>
      send([
        { folder: first, chain: good, source },
        { folder: second, chain: chain(3, 31, 1) },
      ]);

    await expect(sendSource({ device: "8", path: "/lib" })).rejects.toThrow(/source/u);
    await expect(sendSource({ device: "8:1", path: "lib" })).rejects.toThrow(/source/u);
    await expect(sendSource({ device: "8:1", path: "/lib/../etc" })).rejects.toThrow(/source/u);
    await expect(sendSource({ device: "8:1", path: "/lib//x" })).rejects.toThrow(/source/u);
    await expect(
      sendSource({ device: "8:1", path: `/${Array.from({ length: 65 }, () => "a").join("/")}` }),
    ).rejects.toThrow(/source/u);
    await expect(sendSource({ device: "8:1", path: `/${"a".repeat(4096)}` })).rejects.toThrow(
      /source/u,
    );

    await scanCalls(stack, "claims-defect-end").finish(lease);
    await remove(admin, pair);
  });

  it("stay inside Convex's limits at 16 folders of 64 identities and 64-part source paths", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "claims-max", "admin");
    const boot = `boot-${unique()}`;
    const widest = await library(admin, 16);

    expect(await claimRead(stack, admin, widest, boot, widestRead(1))).toEqual({ claimed: true });

    const mark = await logMark(stack);

    // A whole new claim for every folder deletes 1,040 rows and inserts 1,040.
    expect(await claimRead(stack, admin, widest, boot, widestRead(2))).toEqual({ claimed: true });

    const replaced = (await usageSince(stack, mark, api.core.scans.claimFolders, 1)).find(
      (call) => call.committed,
    );

    expect(replaced?.writes).toBeGreaterThanOrEqual(2080);
    expect(replaced?.writes).toBeLessThan(8192);
    expect(replaced?.reads).toBeLessThan(32_000);
    expect(replaced?.bytes).toBeLessThan(8 * 1024 * 1024);

    // The same claim again writes none of its rows.
    expect(await claimRead(stack, admin, widest, boot, widestRead(2))).toEqual({ claimed: true });

    await remove(admin, widest);
  });
});

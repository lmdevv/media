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
import { retrying } from "../jobs/driver";
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

const claimHeld = async (
  core: CoreStack,
  lease: ScanLease,
  bootId: string | null,
  folders: ReadonlyArray<{ readonly folder: string; readonly chain: ReadonlyArray<string> }>,
): Promise<Claim> => {
  const answer = await retrying(() =>
    runServer(
      core,
      api.core.scans.claimFolders,
      {
        lease,
        kind: "music",
        bootId,
        folders: folders.map((entry) => ({ folder: entry.folder, chain: [...entry.chain] })),
      },
      Claimed,
    ),
  );

  if (answer.outcome !== "held") throw new Error(`claimFolders answered ${answer.outcome}`);

  return answer.value;
};

/** One scan of the library that claims `chains`, its folders' in path order, and then ends. */
const claim = async (
  core: CoreStack,
  admin: Member,
  of: Library,
  bootId: string | null,
  chains: ReadonlyArray<ReadonlyArray<string>>,
): Promise<Claim> => {
  const lease = await holdScan(core, admin, of);

  const answer = await claimHeld(
    core,
    lease,
    bootId,
    of.folders.map((folder, n) => ({ folder, chain: chains[n] ?? [] })),
  );

  await scanCalls(core, "claims-end").finish(lease);

  return answer;
};

const remove = (admin: Member, of: Library) =>
  admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId: of.libraryId });

/** A chain of identities on device `dev`: the folder's inode first, then each parent's. */
const chain = (dev: number, ...inodes: ReadonlyArray<number>): ReadonlyArray<string> =>
  inodes.map((inode) => `${dev}:${inode}`);

describe.skipIf(stack === undefined)("folder identity claims", { timeout: 300_000 }, () => {
  it("refuse a folder another library of the boot reaches, inside or out, and write nothing", async () => {
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

    // Another boot's identities say nothing about this one's, and the success replaced the claim.
    expect(await claim(stack, admin, linked, `${boot}-next`, [chain(9, 100, 10, 1)])).toEqual({
      claimed: true,
    });
    expect(await claim(stack, admin, third, boot, [chain(9, 300, 10, 1)])).toEqual({
      claimed: true,
    });
    expect(await claim(stack, admin, third, null, [chain(9, 100, 10, 1)])).toEqual({
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

    const send = (folders: ReadonlyArray<{ folder: string; chain: ReadonlyArray<string> }>) =>
      claimHeld(stack, lease, null, folders);

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

    await scanCalls(stack, "claims-defect-end").finish(lease);
    await remove(admin, pair);
  });

  it("stay inside Convex's 4,096 index ranges and 8,192 writes at 16 folders of 64 identities", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "claims-max", "admin");
    const boot = `boot-${unique()}`;
    const widest = await library(admin, 16);

    // Every identity distinct, so the check reads one range per parent of every folder.
    const chains = (base: number) =>
      widest.folders.map((_folder, folder) =>
        chain(base, ...Array.from({ length: 64 }, (_depth, depth) => folder * 64 + depth)),
      );

    expect(await claim(stack, admin, widest, boot, chains(1))).toEqual({ claimed: true });

    const mark = await logMark(stack);

    // A whole new chain for every folder deletes 1,024 rows and inserts 1,024.
    expect(await claim(stack, admin, widest, boot, chains(2))).toEqual({ claimed: true });

    const replaced = (await usageSince(stack, mark, api.core.scans.claimFolders, 1)).find(
      (call) => call.committed,
    );

    expect(replaced?.writes).toBeGreaterThanOrEqual(2048);
    expect(replaced?.writes).toBeLessThan(8192);

    // The same claim again writes none of its rows.
    expect(await claim(stack, admin, widest, boot, chains(2))).toEqual({ claimed: true });

    await remove(admin, widest);
  });
});

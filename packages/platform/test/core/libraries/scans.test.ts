import { join } from "node:path";

import { Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { runFunction } from "../../admin";
import { createPerson, signInAs } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { runServer } from "../../service";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { eventually } from "../jobs/driver";
import { makeTree, removeFiles, removeTree, walk, writeFiles } from "./files";
import { claimScanOf, scanCalls, scanLibrary } from "./scanner";

const stack = coreStackFromEnvFile();

const roots: Array<string> = [];

const tree = async (files: ReadonlyArray<string>): Promise<string> => {
  const root = await makeTree(files);

  roots.push(root);

  return root;
};

afterAll(async () => {
  await Promise.all(roots.map(removeTree));
});

const admin = async (core: CoreStack): Promise<SignedIn["client"]> =>
  (await signInAs(core, await createPerson(core, "admin", "admin"))).client;

const itemsOf = async (
  client: SignedIn["client"],
  libraryId: Id<"libraries">,
): Promise<number | null> => (await client.query(api.core.libraries.get, { libraryId })).items;

const Domains = Schema.Array(Schema.Struct({ kind: Schema.String, hasLibraries: Schema.Boolean }));

describe.skipIf(stack === undefined)("library scans", { timeout: 180_000 }, () => {
  it("count every file on disk, and follow files that appear and vanish", async () => {
    if (stack === undefined) return;
    const owner = await admin(stack);
    const files = Array.from({ length: 1200 }, (_, n) => `shelf-${n % 7}/disc-${n % 3}/${n}.flac`);
    const root = await tree(files);

    const { libraryId } = await owner.mutation(api.core.libraries.create, {
      name: "Records",
      kind: "music",
      folders: [root],
    });

    expect(await scanLibrary(stack, "music", libraryId)).toMatchObject({
      outcome: "succeeded",
      found: 1200,
      inserted: 1200,
    });
    expect(await itemsOf(owner, libraryId)).toBe((await walk(root)).length);

    await removeFiles(root, files.slice(0, 5));
    await writeFiles(root, ["new.flac"]);
    await owner.mutation(api.core.libraries.scan, { libraryId });

    expect(await scanLibrary(stack, "music", libraryId)).toMatchObject({
      inserted: 1,
      removed: 5,
    });
    expect(await itemsOf(owner, libraryId)).toBe(1196);
    expect(await runServer(stack, api.core.scans.domains, {}, Domains)).toContainEqual({
      kind: "music",
      hasLibraries: true,
    });
  });

  it("write nothing for an attempt after its cancel, and free its slot on that call", async () => {
    if (stack === undefined) return;
    const owner = await admin(stack);
    const root = await tree(["a.mkv", "b.mkv"]);

    const { libraryId, scanJobId } = await owner.mutation(api.core.libraries.create, {
      name: "Films",
      kind: "movies",
      folders: [root],
    });

    const calls = scanCalls(stack, "canceled");
    const lease = await claimScanOf(calls, "movies", libraryId);

    expect(await calls.target(lease, "movies")).toMatchObject({ outcome: "held" });
    await runFunction(
      stack,
      internal.core.jobs.admin.cancel,
      { jobId: lease.jobId },
      Schema.Struct({ outcome: Schema.String }),
    );

    const files = await walk(root);

    expect(await calls.upsert(lease, "movies", files)).toEqual({ outcome: "canceled" });
    expect(await calls.upsert(lease, "movies", files)).toEqual({ outcome: "canceled" });
    expect(await itemsOf(owner, libraryId)).toBe(0);
    expect((await owner.query(api.core.libraries.get, { libraryId })).scan).toMatchObject({
      jobId: scanJobId,
      status: "canceled",
    });
    await expect(calls.upsert(lease, "music", files)).rejects.toThrow(/movies\.scan/u);
  });

  it("write a path sent twice in one batch once", async () => {
    if (stack === undefined) return;
    const owner = await admin(stack);
    const root = await tree(["a.flac", "b.flac"]);

    const { libraryId } = await owner.mutation(api.core.libraries.create, {
      name: "Twice",
      kind: "music",
      folders: [root],
    });

    const calls = scanCalls(stack, "twice");
    const lease = await claimScanOf(calls, "music", libraryId);
    const [first, second] = await walk(root);

    if (first === undefined || second === undefined) throw new Error("The tree holds two files");

    expect(await calls.upsert(lease, "music", [first, first, second])).toEqual({
      outcome: "held",
      value: { inserted: 2 },
    });
    expect(await calls.missing(lease, "music", [first.path, first.path])).toEqual({
      outcome: "held",
      value: { removed: 1 },
    });
    expect(await itemsOf(owner, libraryId)).toBe(1);
  });

  it("drop what a removed folder held from the count, and refuse writes outside the folders", async () => {
    if (stack === undefined) return;
    const owner = await admin(stack);

    const root = await tree([
      ...Array.from({ length: 30 }, (_, n) => `kept/${n}.mkv`),
      ...Array.from({ length: 20 }, (_, n) => `dropped/${n}.mkv`),
    ]);

    const { libraryId } = await owner.mutation(api.core.libraries.create, {
      name: "Two folders",
      kind: "movies",
      folders: [join(root, "kept"), join(root, "dropped")],
    });

    await scanLibrary(stack, "movies", libraryId);

    expect(await itemsOf(owner, libraryId)).toBe(50);

    await owner.mutation(api.core.libraries.setFolders, {
      libraryId,
      folders: [join(root, "kept")],
    });

    expect(
      await eventually("the dropped folder's items to leave", async () =>
        (await itemsOf(owner, libraryId)) === 30 ? true : null,
      ),
    ).toBe(true);

    const calls = scanCalls(stack, "outside");
    const lease = await claimScanOf(calls, "movies", libraryId);

    await expect(
      calls.upsert(lease, "movies", [{ path: join(root, "dropped", "0.mkv"), size: 1, mtime: 1 }]),
    ).rejects.toThrow(/not a path inside/u);
    expect(await itemsOf(owner, libraryId)).toBe(30);
  });

  it("purge a removed library's items in the background", async () => {
    if (stack === undefined) return;
    const owner = await admin(stack);
    const root = await tree(Array.from({ length: 600 }, (_, n) => `${n}.flac`));

    const { libraryId } = await owner.mutation(api.core.libraries.create, {
      name: "Gone",
      kind: "music",
      folders: [root],
    });

    await scanLibrary(stack, "music", libraryId);
    await owner.mutation(api.core.libraries.remove, { libraryId });

    const Left = Schema.Boolean;

    expect(
      await eventually("the purge to finish", async () =>
        (await runFunction(stack, internal.core.libraryProbe.hasItems, { libraryId }, Left))
          ? null
          : true,
      ),
    ).toBe(true);
  });
});

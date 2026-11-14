import { Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { runFunction } from "../../admin";
import { member } from "../../devices";
import type { Member } from "../../devices";
import { seedLibraries, seedLibrary } from "../../probe";
import { runServer, runServerAs } from "../../service";
import { refusal, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { eventually, inSequence } from "../jobs/driver";
import { scanCalls } from "./scanner";

const stack = coreStackFromEnvFile();

const Queued = Schema.Struct({ queued: Schema.Finite });

const changed = (core: CoreStack, path: string) =>
  runServer(core, api.core.scans.changed, { path }, Queued);

/** The scan a library's `lastScan` names, as its manager reads it, or null when it has none. */
const scanOf = async (manager: Member, libraryId: Id<"libraries">) => {
  const library = await manager.signedIn.client.query(api.core.libraries.get, { libraryId });

  return library.scan === null ? null : { jobId: library.scan.jobId, status: library.scan.status };
};

const moveTo = (core: CoreStack, libraryId: Id<"libraries">, folder: string) =>
  runFunction(
    core,
    internal.movies.probe.setFolders,
    { libraryId, folders: [folder] },
    Schema.Null,
  );

/** Cancels every queued movies scan, so the scans these tests queued leave the queue as it was. */
const cancelQueuedScans = async (core: CoreStack): Promise<void> => {
  const { more } = await runFunction(
    core,
    internal.movies.probe.cancelQueued,
    { kind: "movies.scan" },
    Schema.Struct({ more: Schema.Boolean }),
  );

  if (more) await cancelQueuedScans(core);
};

const movies = (name: string) => ({ name, kind: "movies" as const, items: [] });

afterAll(async () => {
  if (stack !== undefined) await cancelQueuedScans(stack);
});

describe.skipIf(stack === undefined)("rescans after a change", { timeout: 180_000 }, () => {
  it("queue one scan for a change inside a library folder, and join it on the next", async () => {
    if (stack === undefined) return;
    const manager = await member(stack, "changed", "admin");
    const { libraryId } = await seedLibrary(stack, manager, movies("Films"));
    const folder = `/changed-${unique()}/films`;

    await moveTo(stack, libraryId, folder);

    expect(await scanOf(manager, libraryId)).toBeNull();
    expect(await changed(stack, `${folder}/Heat (1995)/Heat.mkv`)).toEqual({ queued: 1 });

    const first = await scanOf(manager, libraryId);

    expect(first).toMatchObject({ status: "queued" });

    expect(await changed(stack, `${folder}//New\u0001name.mkv`)).toEqual({ queued: 1 });
    expect(await changed(stack, folder)).toEqual({ queued: 1 });
    expect(await changed(stack, `${folder}/./`)).toEqual({ queued: 1 });
    expect(await scanOf(manager, libraryId)).toEqual(first);
  });

  it("queue one more scan once a running scan a change joined stops", async () => {
    if (stack === undefined) return;
    await cancelQueuedScans(stack);
    const manager = await member(stack, "changed-running", "admin");
    const { libraryId } = await seedLibrary(stack, manager, movies("Running"));
    const folder = `/changed-${unique()}/running`;

    await moveTo(stack, libraryId, folder);
    expect(await changed(stack, `${folder}/Heat.mkv`)).toEqual({ queued: 1 });

    const first = await scanOf(manager, libraryId);
    const claimed = await scanCalls(stack, `changed-${unique()}`).claim("movies");

    if (first === null || claimed.outcome !== "claimed") throw new Error("No scan to claim");
    expect(claimed.lease.jobId).toBe(first.jobId);

    expect(await changed(stack, `${folder}/Ronin.mkv`)).toEqual({ queued: 1 });
    expect(await scanOf(manager, libraryId)).toEqual({ jobId: first.jobId, status: "running" });

    await runServer(
      stack,
      api.core.jobs.worker.finish,
      { lease: claimed.lease, end: { outcome: "succeeded" } },
      Schema.Unknown,
    );

    const next = await scanOf(manager, libraryId);

    expect(next?.status).toBe("queued");
    expect(next?.jobId).not.toBe(first.jobId);

    expect(await changed(stack, `${folder}/Thief.mkv`)).toEqual({ queued: 1 });
    expect(await scanOf(manager, libraryId)).toEqual(next);
  });

  it("queue every movies and music library inside a root", async () => {
    if (stack === undefined) return;
    const manager = await member(stack, "changed-root", "admin");
    const root = `/changed-${unique()}`;
    const films = await seedLibraries(stack, manager, [movies("A"), movies("B")]);
    const music = await seedLibrary(stack, manager, { name: "M", kind: "music", items: [] });

    await inSequence(films, async ({ libraryId }) =>
      moveTo(stack, libraryId, `${root}/films-${libraryId}`),
    );
    await moveTo(stack, music.libraryId, `${root}/music`);

    expect(await changed(stack, root)).toEqual({ queued: 3 });
    expect(await changed(stack, `${root}/`)).toEqual({ queued: 3 });

    await inSequence(films, async ({ libraryId }) => {
      expect(await scanOf(manager, libraryId)).toMatchObject({ status: "queued" });
    });

    const songScan = await scanOf(manager, music.libraryId);

    expect(songScan).toMatchObject({ status: "queued" });
    expect(await changed(stack, `${root}/music/Song.flac`)).toEqual({ queued: 1 });
    expect(await scanOf(manager, music.libraryId)).toEqual(songScan);
  });

  it("queue nothing for a path in no library", async () => {
    if (stack === undefined) return;

    expect(await changed(stack, `/changed-${unique()}/elsewhere/Film.mkv`)).toEqual({
      queued: 0,
    });
  });

  it("rescan the folders inside a root past one call's page in scheduled calls", async () => {
    if (stack === undefined) return;
    const manager = await member(stack, "changed-many", "admin");
    const root = `/changed-${unique()}`;

    const many = await seedLibraries(
      stack,
      manager,
      Array.from({ length: 70 }, (_, n) => movies(`Shelf ${n}`)),
    );

    await inSequence(many, async ({ libraryId }) =>
      moveTo(stack, libraryId, `${root}/${libraryId}`),
    );

    expect(await changed(stack, root)).toEqual({ queued: 64 });

    await eventually("every library inside the root to be queued", async () => {
      const scans = await inSequence(many, async ({ libraryId }) => scanOf(manager, libraryId));

      return scans.every((scan) => scan !== null) ? scans : null;
    });
  });

  it("refuse a path that is not absolute or too long, and any caller but the media service", async () => {
    if (stack === undefined) return;
    const person = await member(stack, "changed-person", "admin");

    expect(await refusal(changed(stack, "films/Heat.mkv"))).toBe("invalid_args");
    expect(await refusal(changed(stack, `/${"x".repeat(4096)}`))).toBe("invalid_args");
    expect(await changed(stack, `/${"x".repeat(4095)}`)).toEqual({ queued: 0 });
    expect(
      await refusal(
        runServerAs(stack, person.signedIn, api.core.scans.changed, { path: "/films" }, Queued),
      ),
    ).toBe("forbidden");
  });
});

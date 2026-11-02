import { type LibraryId, type TrackId, UserId } from "@music/commands/ids";
import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import {
  allTracks,
  drainScheduled,
  MEDIA_SECRET,
  makeBackend,
  signUp,
  upsertFiles,
} from "./backend";
import type { Backend, User } from "./backend";
import { failure, failureCode } from "./harness";

const OVERLAP =
  "This folder is the same as, inside, or around another library's folder (through a link or a " +
  "mount), so it was not scanned. Add a folder that holds only this library's music.";

const libraryDoc = async (backend: Backend, libraryId: LibraryId) => {
  const library = await backend.run(async (ctx) => {
    const id = ctx.db.normalizeId("libraries", libraryId);

    return id === null ? null : ctx.db.get(id);
  });

  if (library === null) throw new Error(`${libraryId} is not a library`);

  return library;
};

const claim = async (
  backend: Backend,
  libraryId: LibraryId,
  realPath: string,
  rootIds: ReadonlyArray<string> = [`path:${realPath}`],
  fsPath: string | null = null,
  bootId: string | null = "boot-1",
) => {
  const library = await libraryDoc(backend, libraryId);

  return backend.mutation(api.media.claimRoot, {
    secret: MEDIA_SECRET,
    libraryId: library._id,
    realPath,
    rootIds: [...rootIds],
    fsPath,
    bootId,
  });
};

const playable = async (backend: Backend, user: User, trackId: TrackId) => ({
  source: (await backend.query(api.media.trackSource, { secret: MEDIA_SECRET, trackId })) !== null,
  url: await failureCode(user.music.read("stream.url", { trackId, profile: "original" })),
});

const PLAYS = { source: true, url: "succeeded" };

const SILENT = { source: false, url: "not_found" };

describe("real folder claims", () => {
  it("refuse a folder that is, sits inside, or holds another library's, by any name", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const admin = await signUp(backend, "admin");

    const kept = await owner.music.run("libraries.create", {
      name: "Kept",
      path: "/srv/x/owner-private",
      visibility: "private",
    });

    const legacy = await owner.music.run("libraries.create", { name: "Old", path: "/data/old" });

    expect(await claim(backend, kept.libraryId, "/srv/x/owner-private")).toEqual({ ok: true });

    const alias = await admin.music.run("libraries.create", { name: "Alias", path: "/home/link" });

    const overlapping = await Promise.all(
      ["/srv/x", "/srv/x/owner-private", "/srv/x/owner-private/a", "/data/old"].map((real) =>
        claim(backend, alias.libraryId, real),
      ),
    );

    expect(overlapping).toEqual(Array.from({ length: 4 }, () => ({ ok: false, error: OVERLAP })));

    const system = await Promise.all(
      ["/proc/1/root", "/sys", "/dev/shm", "/"].map((real) =>
        claim(backend, alias.libraryId, real),
      ),
    );

    expect(system.map((result) => result.ok)).toEqual([false, false, false, false]);

    expect(await claim(backend, alias.libraryId, "/srv/y")).toEqual({ ok: true });
    expect(await claim(backend, alias.libraryId, "/srv/y")).toEqual({ ok: true });
    expect(await claim(backend, legacy.libraryId, "/data/old")).toEqual({ ok: true });

    const stored = await backend.run(async (ctx) =>
      (await ctx.db.query("libraries").collect()).map((library) => library.realPath ?? null),
    );

    expect(stored.toSorted((left, right) => String(left).localeCompare(String(right)))).toEqual([
      "/data/old",
      "/srv/x/owner-private",
      "/srv/y",
    ]);
  });

  it("refuse a folder that is, sits inside, or holds another's by identity, as a bind mount", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const admin = await signUp(backend, "admin");

    const [top, srv, x, mine] = ["1:2", "1:10", "1:11", "1:12"];

    const kept = await owner.music.run("libraries.create", {
      name: "Kept",
      path: "/srv/x/owner-private",
      visibility: "private",
    });

    expect(
      await claim(backend, kept.libraryId, "/srv/x/owner-private", [mine, x, srv, top]),
    ).toEqual({ ok: true });

    const stored = await libraryDoc(backend, kept.libraryId);

    expect(stored.rootIds).toEqual([mine, x, srv, top]);

    const alias = await admin.music.run("libraries.create", { name: "Alias", path: "/mnt/b" });
    const mnt = "1:30";

    const refused = await Promise.all(
      [
        [mine, mnt, top],
        ["1:13", mine, mnt, top],
        [x, mnt, top],
      ].map((chain) => claim(backend, alias.libraryId, "/mnt/b", chain)),
    );

    expect(refused).toEqual(Array.from({ length: 3 }, () => ({ ok: false, error: OVERLAP })));
    expect(OVERLAP).not.toMatch(/srv|1:/u);

    expect(await claim(backend, alias.libraryId, "/mnt/b", ["1:31", mnt, top])).toEqual({
      ok: true,
    });
  });

  it("compare identities only within one boot, and paths always", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const admin = await signUp(backend, "admin");

    const kept = await owner.music.run("libraries.create", { name: "Kept", path: "/music/a" });

    expect(
      await claim(backend, kept.libraryId, "/music/a", ["8:5", "8:1", "0:1"], "8:1:/a", "boot-old"),
    ).toEqual({ ok: true });

    const other = await admin.music.run("libraries.create", { name: "Other", path: "/music/b" });

    expect(
      await claim(
        backend,
        other.libraryId,
        "/music/b",
        ["8:5", "8:1", "0:1"],
        "8:1:/a",
        "boot-new",
      ),
    ).toEqual({ ok: true });
    expect((await libraryDoc(backend, kept.libraryId)).realPath).toBe("/music/a");

    await claim(backend, kept.libraryId, "/music/a", ["8:5", "8:1", "0:1"], "8:1:/a", "boot-new");
    expect(
      await claim(
        backend,
        other.libraryId,
        "/music/b",
        ["8:5", "8:1", "0:1"],
        "8:1:/a",
        "boot-new",
      ),
    ).toEqual({ ok: false, error: OVERLAP });

    expect(
      await claim(backend, other.libraryId, "/music/a/sub", ["9:9"], null, "boot-other"),
    ).toEqual({ ok: false, error: OVERLAP });
  });

  it("refuse a library on a bound subfolder of another, by file system path", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const admin = await signUp(backend, "admin");

    const kept = await owner.music.run("libraries.create", {
      name: "Kept",
      path: "/music/a",
      visibility: "private",
    });

    expect(
      await claim(backend, kept.libraryId, "/music/a", ["8:1", "8:0", "0:1"], "8:1:/srv/a"),
    ).toEqual({ ok: true });

    const bound = await admin.music.run("libraries.create", { name: "Bound", path: "/music/x" });

    expect(
      await claim(backend, bound.libraryId, "/music/x", ["8:7", "0:2", "0:1"], "8:1:/srv/a/sub"),
    ).toEqual({ ok: false, error: OVERLAP });
    expect(
      await claim(backend, bound.libraryId, "/music/x", ["8:9", "0:2", "0:1"], "8:1:/srv"),
    ).toEqual({ ok: false, error: OVERLAP });
    expect(
      await claim(backend, bound.libraryId, "/music/x", ["8:8", "0:2", "0:1"], "8:1:/srv/b"),
    ).toEqual({ ok: true });
    expect(
      await claim(backend, bound.libraryId, "/music/x", ["9:7", "0:2", "0:1"], "9:1:/srv/a/sub"),
    ).toEqual({ ok: true });
  });

  it("stream nothing from a library until a claim succeeds, and stop when one is refused", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");

    const elder = await owner.music.run("libraries.create", { name: "Elder", path: "/srv/elder" });

    const { libraryId } = await owner.music.run("libraries.create", {
      name: "Mine",
      path: "/srv/mine",
    });

    await upsertFiles(backend, libraryId, [{ path: "/srv/mine/a.flac", title: "A" }]);
    const [track] = await allTracks(owner);

    if (track === undefined) throw new Error("The song was not indexed");

    expect(await playable(backend, owner, track.id)).toEqual(PLAYS);

    const mine = await libraryDoc(backend, libraryId);

    await backend.mutation(api.media.refuseRoot, { secret: MEDIA_SECRET, libraryId: mine._id });
    expect(await playable(backend, owner, track.id)).toEqual(SILENT);
    expect(await claim(backend, libraryId, "/srv/mine", ["7:1", "7:0"])).toEqual({ ok: true });
    expect(await playable(backend, owner, track.id)).toEqual(PLAYS);

    expect(await claim(backend, elder.libraryId, "/srv/elder", ["4:1", "4:0"])).toEqual({
      ok: true,
    });
    expect(await claim(backend, libraryId, "/srv/mine", ["4:1", "7:0"])).toEqual({
      ok: false,
      error: OVERLAP,
    });
    expect(await playable(backend, owner, track.id)).toEqual(SILENT);

    const dropped = await libraryDoc(backend, libraryId);

    expect([dropped.realPath, dropped.rootIds]).toEqual([undefined, undefined]);
  });

  it("give a folder to the library added first, even when a newer one claimed it first", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const admin = await signUp(backend, "admin");

    const { libraryId } = await owner.music.run("libraries.create", {
      name: "Mine",
      path: "/srv/mine",
      visibility: "private",
    });

    await upsertFiles(backend, libraryId, [{ path: "/srv/mine/a.flac", title: "A" }]);
    const [track] = await allTracks(owner);

    if (track === undefined) throw new Error("The song was not indexed");

    const mine = await libraryDoc(backend, libraryId);

    await backend.run(async (ctx) => {
      await ctx.db.patch(mine._id, { realPath: undefined, rootIds: undefined });
    });

    const other = await admin.music.run("libraries.create", { name: "Other", path: "/mnt/m" });

    expect(await claim(backend, other.libraryId, "/mnt/m", ["9:1", "9:0"])).toEqual({ ok: true });

    expect(await claim(backend, libraryId, "/srv/mine", ["9:1", "8:0"])).toEqual({ ok: true });
    expect(await playable(backend, owner, track.id)).toEqual(PLAYS);
    expect((await libraryDoc(backend, other.libraryId)).realPath).toBeUndefined();
    expect(await claim(backend, other.libraryId, "/mnt/m", ["9:1", "9:0"])).toEqual({
      ok: false,
      error: OVERLAP,
    });
  });

  it("claim libraries from before claims at a scan the upgrade starts", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");

    const created = await Promise.all(
      ["/srv/old", "/srv/half"].map((path, index) =>
        owner.music.run("libraries.create", { name: `Old ${String(index)}`, path }),
      ),
    );

    const [old, half] = created.map((library) => library.libraryId);

    if (old === undefined || half === undefined) throw new Error("Libraries were not created");

    await upsertFiles(backend, old, [{ path: "/srv/old/a.flac", title: "Old" }]);
    const [track] = await allTracks(owner);

    if (track === undefined) throw new Error("The song was not indexed");

    await backend.run(async (ctx) => {
      const libraries = await ctx.db.query("libraries").collect();
      const jobs = await ctx.db.query("jobs").collect();

      await Promise.all([
        ...jobs.map(async (job) => ctx.db.patch(job._id, { status: "done" })),
        ...libraries.map(async (library) =>
          ctx.db.patch(library._id, {
            realPath: library.path === "/srv/half" ? library.path : undefined,
            rootIds: undefined,
          }),
        ),
      ]);
    });

    expect(await playable(backend, owner, track.id)).toEqual(SILENT);

    const listed = await backend.query(api.media.libraries, { secret: MEDIA_SECRET });

    expect(listed.map((library) => library.claimed)).toEqual([false, false]);

    await backend.mutation(internal.migrations.run, {});
    await drainScheduled(backend);

    const pending = await backend.query(api.media.pendingJobs, { secret: MEDIA_SECRET });

    expect(pending).toHaveLength(2);

    expect(await claim(backend, old, "/srv/old", ["5:1", "5:0"])).toEqual({ ok: true });
    expect(await claim(backend, half, "/srv/half", ["6:1", "5:0"])).toEqual({ ok: true });
    expect(await playable(backend, owner, track.id)).toEqual(PLAYS);
    expect((await libraryDoc(backend, half)).rootIds).toEqual(["6:1", "5:0"]);
  });

  it("refuse /, /proc, /sys, and /dev when a library is added", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");

    const codes = await Promise.all(
      ["/proc/self/root/srv/music", "/sys/x", "/dev/shm/music", "/", "/.."].map((path) =>
        failureCode(owner.music.run("libraries.create", { name: "Sys", path })),
      ),
    );

    expect(codes).toEqual(Array.from({ length: 5 }, () => "invalid_args"));
  });
});

describe("removing and overlapping libraries", () => {
  it("lets only a library's owner or the server's owner remove it", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const admin = await signUp(backend, "admin");

    const { libraryId } = await owner.music.run("libraries.create", {
      name: "Shared with you",
      path: "/music/shared-with-you",
      visibility: "restricted",
    });

    await owner.music.run("libraries.grant", { libraryId, userId: UserId.make(admin.id) });

    expect(await failureCode(admin.music.run("libraries.update", { libraryId, name: "R" }))).toBe(
      "succeeded",
    );
    expect(await failureCode(admin.music.run("libraries.scan", { libraryId }))).toBe("succeeded");
    expect(await failureCode(admin.music.run("libraries.delete", { libraryId }))).toBe("forbidden");

    const own = await admin.music.run("libraries.create", { name: "Own", path: "/music/own" });

    expect(
      await failureCode(admin.music.run("libraries.delete", { libraryId: own.libraryId })),
    ).toBe("succeeded");
    expect(await failureCode(owner.music.run("libraries.delete", { libraryId }))).toBe("succeeded");
  });

  it("names no folder of a library the viewer can't hear in an overlap error", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const admin = await signUp(backend, "admin");

    await owner.music.run("libraries.create", {
      name: "Hidden",
      path: "/srv/hidden/music",
      visibility: "private",
    });

    const attempts = await Promise.all(
      ["/srv/hidden", "/srv/hidden/music", "/srv/hidden/music/a"].map((path) =>
        failure(admin.music.run("libraries.create", { name: "Probe", path })),
      ),
    );

    expect(attempts).toEqual(
      Array.from({ length: 3 }, () => ({
        code: "conflict",
        message: "This folder overlaps another library",
      })),
    );
  });
});

import { join } from "node:path";

import { MusicStreamTimingHeader, musicStreamPath } from "@media/contracts/music-playback";
import type { Platform } from "@media/sdk/effect";
import { Effect, Exit, Option, Predicate, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  moveFile,
  PNG,
  replaceInPlace,
  resizeFile,
  setFileTime,
  writeBytes,
  writeSong,
} from "../music/testing/music-songs.ts";
import { makeWorkDir, removeDir } from "../testing/core-host.ts";
import {
  core,
  eventually,
  issueServiceKey,
  personIn,
  runHost,
  startCoreServer,
} from "../testing/core-stack.ts";
import type { CoreServer, Person } from "../testing/core-stack.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";

let scope: Scope.Closeable;

let workDir = "";

let musicRoot = "";

let admin: Person;

let server: CoreServer;

let libraryId: Option.Option<Platform.Id<"libraries">> = Option.none();

/** Every ticket the suite fetched with, which the server's log must never hold. */
const used: Array<string> = [];

const library = (): Platform.Id<"libraries"> =>
  Option.getOrThrowWith(libraryId, () => new Error("The music library was not created"));

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const ScanEnd = Schema.Struct({ status: Schema.String, message: Schema.NullOr(Schema.String) });

type ScanEnd = typeof ScanEnd.Type;

const ended = (jobId: string): Promise<ScanEnd> =>
  eventually(
    "the scan to end",
    async () => {
      const job = await runHost("core/jobs/admin:get", { jobId }, ScanEnd);

      return job.status === "succeeded" || job.status === "failed"
        ? Option.some(job)
        : Option.none();
    },
    120_000,
  );

const Issued = Schema.Struct({ ticket: Schema.String, expiresAt: Schema.Finite });

/** Asks for a scan of the music library and waits for its own scan to end. */
const scanNow = async (mode?: "full"): Promise<ScanEnd> => {
  const queued = await run(
    admin.platform.core.libraries.scan(
      mode === undefined ? { libraryId: library() } : { libraryId: library(), mode },
    ),
  );

  const job = await ended(queued.jobId);

  return queued.created ? job : scanNow(mode);
};

const tracksOf = (platform: Platform.Interface) =>
  run(platform.music.tracks.list({ paginationOpts: { numItems: 50, cursor: null } })).then(
    (page) => page.page,
  );

const trackNamed = async (platform: Platform.Interface, title: string) => {
  const found = (await tracksOf(platform)).find((track) => track.title === title);

  if (found === undefined) throw new Error(`No track titled ${title}`);

  return found;
};

const streamUrl = (trackId: string, ticket: string, query = "") =>
  `${server.baseUrl}${musicStreamPath(trackId)}?ticket=${encodeURIComponent(ticket)}${query}`;

/** Reads a body to its end: how many bytes came, and whether the server cut it off. */
const drain = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bytes: number,
): Promise<{ readonly bytes: number; readonly aborted: boolean }> => {
  const next = await reader.read().catch(() => null);

  if (next === null) return { bytes, aborted: true };

  return next.done ? { bytes, aborted: false } : drain(reader, bytes + next.value.byteLength);
};

describe.skipIf(core === undefined || !(await ffmpegAvailable()))(
  "music on the server and the core",
  () => {
    beforeAll(async () => {
      scope = await run(Scope.make());
      workDir = await makeWorkDir("media-music-stack-");
      musicRoot = join(workDir, "library", "music");

      const album = join(musicRoot, "Stack Band", "Stack Album");

      await writeSong(join(album, "01 First.flac"), {
        seconds: 3,
        tags: { title: "First", artist: "Stack Band", album: "Stack Album", track: "1" },
      });
      await writeSong(join(album, "02 Second.mp3"), {
        seconds: 2,
        tags: {
          title: "Second",
          artist: "Stack Band",
          album: "Stack Album",
          track: "2",
          ITUNESADVISORY: "1",
        },
      });
      await writeBytes(join(album, "cover.png"), PNG);
      await writeSong(join(musicRoot, "Long.wav"), { seconds: 1, tags: { title: "Long" } });

      admin = await personIn(scope, "admin");

      server = await startCoreServer(scope, {
        serviceKey: await issueServiceKey(),
        libraryRoot: join(workDir, "library"),
        workDir: join(workDir, "server"),
      });

      const created = await run(
        admin.platform.core.libraries.create({
          name: "Stack music",
          kind: "music",
          folders: [musicRoot],
        }),
      );

      libraryId = Option.some(created.libraryId);
    }, 180_000);

    afterAll(async () => {
      if (Option.isSome(libraryId)) {
        await run(
          admin.platform.core.libraries.remove({ libraryId: libraryId.value }).pipe(Effect.ignore),
        );
      }

      await run(Scope.close(scope, Exit.void));
      await removeDir(workDir);
    }, 60_000);

    it("scans the folder into the core's music catalog, and a rescan writes nothing", async () => {
      const tracks = await eventually(
        "the scan writes the songs",
        async () => {
          const found = await tracksOf(admin.platform);

          return found.length >= 3 ? Option.some(found) : Option.none();
        },
        120_000,
      );

      expect(tracks.map((track) => track.title).toSorted()).toEqual(["First", "Long", "Second"]);
      const first = tracks.find((track) => track.title === "First");

      expect(first).toMatchObject({
        artist: "Stack Band",
        album: "Stack Album",
        trackNumber: 1,
        codec: "flac",
        lossless: true,
      });
      expect(first?.artUrl).toMatch(/^\/music\/art\/[0-9a-f]{64}\?ticket=/u);

      const again = await scanNow();

      expect(again).toMatchObject({ status: "succeeded" });
      expect(again.message).toBe("3 files, 0 updated, 0 missing");
    }, 300_000);

    it("serves art at the URL the music commands return", async () => {
      const first = await trackNamed(admin.platform, "First");
      const response = await fetch(`${server.baseUrl}${first.artUrl ?? ""}`);

      used.push(new URL(first.artUrl ?? "", server.baseUrl).searchParams.get("ticket") ?? "");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);

      const again = await trackNamed(admin.platform, "First");

      expect(again.artUrl).toBe(first.artUrl);
    }, 60_000);

    it("streams a song and its gapless transcode to a ticket from music.play.start", async () => {
      const first = await trackNamed(admin.platform, "First");
      const started = await run(admin.platform.music.play.start({ trackId: first.id }));

      used.push(started.ticket);
      const original = await fetch(streamUrl(first.id, started.ticket));

      expect(original.status).toBe(200);
      expect(original.headers.get("content-type")).toBe("audio/flac");
      expect((await original.arrayBuffer()).byteLength).toBeGreaterThan(0);

      const head = await fetch(streamUrl(first.id, started.ticket, "&p=fmp4-aac"), {
        method: "HEAD",
      });

      expect(head.status).toBe(200);
      expect(head.headers.get(MusicStreamTimingHeader.duration)).toBe(String(3 * 44_100));

      const second = await trackNamed(admin.platform, "Second");

      expect((await fetch(streamUrl(second.id, started.ticket))).status).toBe(403);
    }, 120_000);

    it("follows a moved song, keeping its track", async () => {
      const second = await trackNamed(admin.platform, "Second");

      await moveFile(
        join(musicRoot, "Stack Band", "Stack Album", "02 Second.mp3"),
        join(musicRoot, "Stack Band", "Stack Album", "02 Second (moved).mp3"),
      );

      const scanned = await scanNow();

      expect(scanned.message).toBe("3 files, 0 updated, 1 moved, 0 missing");
      expect((await trackNamed(admin.platform, "Second")).id).toBe(second.id);
    }, 300_000);

    it("reads a tag edited in place again on a full scan", async () => {
      const song = join(musicRoot, "Stack Band", "Stack Album", "01 First.flac");
      const at = 1_700_000_000_000;

      await setFileTime(song, at);
      await scanNow();

      // The same size and modification time: only the title's text differs.
      await replaceInPlace(song, "title=First", "title=Fifth");
      await setFileTime(song, at);

      expect((await scanNow()).message).toBe("3 files, 0 updated, 0 missing");
      expect((await tracksOf(admin.platform)).map((track) => track.title)).toContain("First");

      const full = await scanNow("full");

      expect(full).toMatchObject({ status: "succeeded", message: "3 files, 3 updated, 0 missing" });
      expect((await tracksOf(admin.platform)).map((track) => track.title).toSorted()).toEqual([
        "Fifth",
        "Long",
        "Second",
      ]);
    }, 300_000);

    it("serves no more bytes to an expired ticket once the listener's access is removed", async () => {
      const listener = await personIn(scope, "member", "revoked");
      const { userId, sessionId } = await run(listener.platform.core.auth.sessions.current());
      const resource = { type: "library", id: library() } as const;
      const principal = { kind: "user", userId } as const;

      await run(admin.platform.core.permissions.grants.set({ resource, principal, level: "view" }));

      const second = await trackNamed(listener.platform, "Second");

      await run(listener.platform.music.play.start({ trackId: second.id }));

      const short = await runHost(
        "core/ticketsProbe:issuePersonal",
        {
          sessionId,
          resource: { kind: "track", id: second.id },
          purpose: "play",
          lifetimeMs: 2000,
        },
        Issued,
      );

      used.push(short.ticket);
      const first = await fetch(streamUrl(second.id, short.ticket));

      expect(first.status).toBe(200);
      expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(0);

      await run(admin.platform.core.permissions.grants.remove({ resource, principal }));

      const refused = await run(
        listener.platform.music.play.start({ trackId: second.id }).pipe(Effect.flip),
      );

      expect(Predicate.isTagged(refused, "NotFound")).toBe(true);

      // Tickets hold whole seconds, so this one has expired 3 s later.
      await new Promise((resolve) => setTimeout(resolve, 3100));

      const answers = await Promise.all(
        ["", "", "", "", "&p=aac-128"].map(async (query) => {
          const response = await fetch(streamUrl(second.id, short.ticket, query));

          return [response.status, await response.text()] as const;
        }),
      );

      expect(answers).toEqual(Array.from({ length: 5 }, () => [401, "Invalid or expired ticket"]));
    }, 120_000);

    it("stops a song once its listener signs out", async () => {
      const listener = await personIn(scope, "admin", "listener");
      const listenerId = (await run(listener.platform.core.auth.sessions.current())).userId;

      await run(
        admin.platform.core.permissions.grants.set({
          resource: { type: "library", id: library() },
          principal: { kind: "user", userId: listenerId },
          level: "view",
        }),
      );

      await resizeFile(join(musicRoot, "Long.wav"), 128 * 1024 * 1024);
      await scanNow();

      const long = await trackNamed(listener.platform, "Long");
      const started = await run(listener.platform.music.play.start({ trackId: long.id }));

      used.push(started.ticket);
      const response = await fetch(streamUrl(long.id, started.ticket));

      expect(response.status).toBe(200);

      if (response.body === null) throw new Error("No body");

      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      const opened = await reader.read();

      expect(opened.done).toBe(false);

      await run(listener.platform.session.signOut);

      const received = await drain(reader, opened.value?.byteLength ?? 0);

      expect(received.aborted).toBe(true);
      expect(received.bytes).toBeLessThan(128 * 1024 * 1024);
    }, 180_000);

    it("keeps every ticket out of the log, its debug access log included", () => {
      const lines = server.logged().join("\n");

      expect(used.length).toBeGreaterThan(0);
      expect(lines).toContain("HttpServer.response");
      expect(lines).toContain("/media/music/stream/");

      for (const ticket of used) expect(lines).not.toContain(ticket);

      expect(lines).not.toMatch(/t1\.[a-z0-9]+\.media\./u);
      expect(lines).not.toContain("ticket=");
    });
  },
);

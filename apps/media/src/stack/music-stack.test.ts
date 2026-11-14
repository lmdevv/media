import { join } from "node:path";

import { MusicStreamTimingHeader, musicStreamPath } from "@media/contracts/music-playback";
import type { Platform } from "@media/sdk/effect";
import { Effect, Exit, Option, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { moveFile, PNG, resizeFile, writeBytes, writeSong } from "../music/testing/music-songs.ts";
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

/** Asks for a scan of the music library and waits for its own scan to end. */
const scanNow = async (): Promise<ScanEnd> => {
  const queued = await run(admin.platform.core.libraries.scan({ libraryId: library() }));
  const job = await ended(queued.jobId);

  return queued.created ? job : scanNow();
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

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);

      const again = await trackNamed(admin.platform, "First");

      expect(again.artUrl).toBe(first.artUrl);
    }, 60_000);

    it("streams a song and its gapless transcode to a ticket from music.play.start", async () => {
      const first = await trackNamed(admin.platform, "First");
      const started = await run(admin.platform.music.play.start({ trackId: first.id }));
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
  },
);

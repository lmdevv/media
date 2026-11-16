import { join } from "node:path";

import { HealthResponse, MEDIA_ROUTES } from "@media/contracts/media-playback";
import { musicStreamPath } from "@media/contracts/music-playback";
import type { Platform } from "@media/sdk/effect";
import { Duration, Effect, Exit, Option, Redacted, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ffmpegHangingOnName } from "../music/testing/hanging-ffmpeg.ts";
import { resizeFile, writeSong } from "../music/testing/music-songs.ts";
import { STOP_DEADLINE } from "../shutdown-deadline.ts";
import { freePort, makeWorkDir, removeDir, ticketKeysText } from "../testing/core-host.ts";
import { core, eventually, issueServiceKey, personIn } from "../testing/core-stack.ts";
import type { Person } from "../testing/core-stack.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { buildService, startMedia, waitForBody } from "../testing/stack-processes.ts";
import type { MediaProcess } from "../testing/stack-processes.ts";

const decodeHealth = Schema.decodeUnknownOption(Schema.fromJsonString(HealthResponse));

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

/** How long the suite waits for the service to exit before it calls the stop hung. */
const HUNG_AFTER_MS = 20_000;

let scope: Scope.Closeable;

let workDir = "";

let admin: Person;

let libraryId: Option.Option<Platform.Id<"libraries">> = Option.none();

type Track = Awaited<ReturnType<typeof firstPage>>["page"][number];

const firstPage = (platform: Platform.Interface, cursor: string | null) =>
  run(platform.music.tracks.list({ paginationOpts: { numItems: 200, cursor } }));

/** Every song `platform`'s person may play, page by page. */
const allTracks = async (
  platform: Platform.Interface,
  cursor: string | null = null,
  found: ReadonlyArray<Track> = [],
): Promise<ReadonlyArray<Track>> => {
  const page = await firstPage(platform, cursor);
  const all = [...found, ...page.page];

  return page.isDone ? all : allTracks(platform, page.continueCursor, all);
};

/** Reads the first chunk of `response`'s body and leaves the rest unread, as a paused player. */
const readFirst = async (response: Response): Promise<void> => {
  expect(response.status).toBeLessThan(300);

  if (response.body === null) throw new Error("No body");

  expect((await response.body.getReader().read()).done).toBe(false);
};

describe.skipIf(core === undefined || !(await ffmpegAvailable()))(
  "the media service under SIGTERM",
  () => {
    let media: MediaProcess | undefined;

    beforeAll(async () => {
      buildService();
      scope = await run(Scope.make());
      workDir = await makeWorkDir("media-stop-stack-");
      admin = await personIn(scope, "admin");
    }, 120_000);

    afterAll(async () => {
      await media?.stop("SIGKILL");

      if (Option.isSome(libraryId)) {
        await run(
          admin.platform.core.libraries.remove({ libraryId: libraryId.value }).pipe(Effect.ignore),
        );
      }

      await run(Scope.close(scope, Exit.void));
      await removeDir(workDir);
    }, 60_000);

    it("exits within its deadline with a hung request, a transcode, and a stream open", async () => {
      const musicRoot = join(workDir, "library", "music");
      const ffmpeg = await ffmpegHangingOnName(workDir);

      // The library's songs, named apart from every other suite's.
      const tag = crypto.randomUUID().slice(0, 8);
      const titled = (title: string) => ({ title: `${title} ${tag}` });

      await writeSong(join(musicRoot, "01 slow.mp3"), { seconds: 120, tags: titled("Slow") });
      await writeSong(join(musicRoot, "02 hang.flac"), { seconds: 2, tags: titled("Hang") });
      await writeSong(join(musicRoot, "03 big.wav"), { seconds: 1, tags: titled("Big") });
      // Far larger than socket buffers, so its response is still open at the stop.
      await resizeFile(join(musicRoot, "03 big.wav"), 64 * 1024 * 1024);

      const port = await freePort();
      const baseUrl = `http://127.0.0.1:${String(port)}`;

      media = startMedia({
        CONVEX_URL: core?.url ?? "",
        MEDIA_SERVICE_API_KEY: Redacted.value(await issueServiceKey()),
        MEDIA_TICKET_KEYS: ticketKeysText(),
        PORT: String(port),
        HOST: "127.0.0.1",
        MEDIA_BASE_URL: baseUrl,
        LIBRARY_ROOTS: join(workDir, "library"),
        DATA_DIR: join(workDir, "data"),
        TRANSCODE_DIR: join(workDir, "transcode"),
        BACKUP_DIR: join(workDir, "backups"),
        MIN_FREE_TRANSCODE_MB: "1",
        HARDWARE_ACCELERATION: "none",
        FFMPEG_PATH: ffmpeg.path,
      });

      await waitForBody(
        `${baseUrl}${MEDIA_ROUTES.health}`,
        (text) =>
          decodeHealth(text).pipe(
            Option.filter((health) => health.backend === "connected"),
            Option.getOrUndefined,
          ),
        60_000,
      );

      const created = await run(
        admin.platform.core.libraries.create({
          name: `Stop music ${tag}`,
          kind: "music",
          folders: [musicRoot],
        }),
      );

      libraryId = Option.some(created.libraryId);

      const tracks = await eventually(
        "the scan writes the songs",
        async () => {
          const found = (await allTracks(admin.platform)).filter((track) =>
            track.title.endsWith(` ${tag}`),
          );

          return found.length === 3 ? Option.some(found) : Option.none();
        },
        120_000,
      );

      const streamOf = async (title: string, query: string) => {
        const track = tracks.find((each) => each.title === titled(title).title);

        if (track === undefined) throw new Error(`No track titled ${title}`);
        const { ticket } = await run(admin.platform.music.play.start({ trackId: track.id }));

        return `${baseUrl}${musicStreamPath(track.id)}?ticket=${encodeURIComponent(ticket)}${query}`;
      };

      await readFirst(await fetch(await streamOf("Big", "")));
      await readFirst(await fetch(await streamOf("Slow", "&p=fmp4-aac")));

      // A request that never answers: a byte range waits for a finished file that never comes.
      const hung = fetch(await streamOf("Hang", "&p=fmp4-aac"), {
        headers: { range: "bytes=0-1023" },
      }).catch(() => null);

      // A HEAD for that song's exact timing, which its player gives up on after half a second, as
      // a Jam's player does when it moves on: it answers from what is ready, holding nothing open.
      const leaving = new AbortController();

      const head = fetch(await streamOf("Hang", "&p=fmp4-aac"), {
        method: "HEAD",
        signal: leaving.signal,
      }).then(
        (answer) => answer.status,
        () => null,
      );

      await eventually("the hung transcode to start", async () =>
        (await ffmpeg.runs()).running >= 2 ? Option.some(true) : Option.none(),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      leaving.abort();
      const headStatus = await head;

      const stoppingAt = Date.now();
      const stopped = media.stop("SIGTERM").then(() => "exited" as const);

      const outcome = await Promise.race([
        stopped,
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), HUNG_AFTER_MS)),
      ]);

      const tookMs = Date.now() - stoppingAt;

      await hung;

      expect(outcome, media.logs().slice(-4000)).toBe("exited");
      expect({ code: media.child.exitCode, signal: media.child.signalCode }).toEqual({
        code: 0,
        signal: null,
      });
      expect(tookMs).toBeLessThan(Duration.toMillis(STOP_DEADLINE));
      expect(media.logs()).not.toContain("Main.shutdown_overran");
      expect((await ffmpeg.runs()).running).toBe(0);
      expect(headStatus).toBe(503);
    }, 300_000);
  },
);

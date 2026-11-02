import { artworkUrl } from "@movies/contracts/artwork";
import {
  ClientDiagnosticsRequest,
  DIAGNOSTICS_ROUTES,
  LogRecord,
  PlaybackDiagnostics,
  PlayerObservation,
} from "@movies/contracts/diagnostics";
import { DeviceId } from "@movies/contracts/ids";
import type { LibraryId, ProfileId, TitleId } from "@movies/contracts/ids";
import {
  type ClientCapabilities,
  HealthResponse,
  MEDIA_ROUTES,
  NegotiateRequest,
  NegotiateResponse,
} from "@movies/contracts/media-playback";
import type { StartedPlayback } from "@movies/contracts/models/playback";
import { trickplayManifestUrl, trickplaySheetUrl } from "@movies/contracts/trickplay";
import { Milliseconds } from "@movies/contracts/units";
import type { Movies } from "@movies/sdk/effect";
import { Auth, ConvexTransport, MoviesClient } from "@movies/sdk/effect";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Option,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ffmpegAvailable, generateFixtureLibrary } from "../testing/fixture-library.ts";
import type { MediaProcess } from "../testing/stack-processes.ts";
import {
  client,
  finished,
  openSession,
  OWNER_EMAILS,
  runIn,
  signInOwner,
  STACK_PASSWORD,
  type StackSession,
} from "../testing/stack-owner.ts";
import {
  buildServiceAndCli,
  ffprobeUrl,
  findMediaStack,
  makeTempDir,
  removeDir,
  runMovies,
  startMedia,
  waitForBody,
} from "../testing/stack-processes.ts";

const stack = findMediaStack();

const hasFfmpeg = await ffmpegAvailable();

const id = Math.random().toString(36).slice(2, 8);

const convexUrl = stack?.convexUrl ?? "";

const mediaUrl = stack?.mediaUrl ?? "";

const timings: Record<string, number> = {};

const browser: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }, { codec: "ac3", maxChannels: 6 }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
};

const smallScreen: ClientCapabilities = {
  containers: browser.containers,
  videoCodecs: browser.videoCodecs,
  audioCodecs: browser.audioCodecs,
  maxWidth: 160,
  maxHeight: 90,
  hls: browser.hls,
  mse: browser.mse,
};

let scope: Scope.Closeable;

let owner: StackSession;

let media: MediaProcess;

let workspace = "";

let fixtures = { moviesRoot: "", showsRoot: "" };

let profileId: ProfileId;

let moviesLibrary: LibraryId;

let showsLibrary: LibraryId;

const libraries: Array<LibraryId> = [];

const mediaEnv = () => ({
  ...stack?.mediaEnv,
  LIBRARY_ROOTS: workspace,
  HARDWARE_ACCELERATION: "none",
  STREAM_IDLE_SECONDS: "120",
  LIBRARY_RECONCILE_MINUTES: "600",
  MIN_FREE_TRANSCODE_MB: "1",
});

const decodeHealth = Schema.decodeUnknownOption(Schema.fromJsonString(HealthResponse));

const decodeSessionEnded = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.TaggedStruct("PlaybackSessionEnded", { sessionId: Schema.String })),
);

const connected = () =>
  waitForBody(
    `${mediaUrl}${MEDIA_ROUTES.health}`,
    (text) =>
      decodeHealth(text).pipe(
        Option.filter((health) => health.backend === "connected"),
        Option.getOrUndefined,
      ),
    30_000,
  );

const startService = async (): Promise<void> => {
  media = startMedia(mediaEnv());

  await connected();
};

const open = () => openSession(convexUrl, mediaUrl, scope);

const asOwner = <A, E>(
  effect: Effect.Effect<A, E, Movies.Services | ConvexTransport.ConvexTransport>,
): Promise<A> => runIn(owner, effect);

const titleIn = (libraryId: LibraryId, name: string) =>
  Effect.gen(function* () {
    const movies = yield* client;
    const found = yield* movies.query("titles.search", { profileId, query: name, limit: 50 });

    const details = yield* Effect.forEach(found, (title) =>
      movies.query("titles.get", { profileId, titleId: title.id }),
    );

    const match = details.find((detail) => detail.libraryId === libraryId && detail.name === name);

    return match ?? (yield* Effect.die(new Error(`No title ${name} in library ${libraryId}`)));
  });

const startSession = (titleId: TitleId, device: string) =>
  Effect.flatMap(client, (movies) =>
    movies.mutate("playback.createSession", {
      profileId,
      deviceId: DeviceId.make(`media-stack-${id}-${device}`),
      titleId,
    }),
  );

const encodeNegotiate = Schema.encodeSync(Schema.toCodecJson(NegotiateRequest));

const encodeBatch = Schema.encodeSync(Schema.toCodecJson(ClientDiagnosticsRequest));

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(LogRecord));

const decodeLogLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);

const decodeDiagnostics = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(PlaybackDiagnostics)),
);

const decodeNegotiated = Schema.decodeUnknownSync(Schema.toCodecJson(NegotiateResponse));

const offer = (started: StartedPlayback, capabilities: ClientCapabilities) =>
  fetch(`${started.mediaBaseUrl}${MEDIA_ROUTES.negotiate}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      encodeNegotiate({ token: Redacted.make(started.token), capabilities, startSeconds: 0 }),
    ),
  });

const negotiate = async (started: StartedPlayback, capabilities: ClientCapabilities) => {
  const begin = performance.now();
  const response = await offer(started, capabilities);
  const body: unknown = await response.json();
  const elapsed = performance.now() - begin;

  expect(response.status, JSON.stringify(body)).toBe(200);

  return { stream: decodeNegotiated(body), elapsedMs: elapsed };
};

const fetchHls = async (playlistUrl: string): Promise<string> => {
  const playlist = await fetch(playlistUrl);
  const text = await playlist.text();

  expect(playlist.status).toBe(200);
  expect(text).toContain("#EXTM3U");

  const base = playlistUrl.slice(0, playlistUrl.lastIndexOf("/") + 1);
  const init = /URI="([^"]+)"/u.exec(text)?.[1] ?? "";
  const segment = text.split("\n").find((line) => line.length > 0 && !line.startsWith("#")) ?? "";

  const parts = await Promise.all(
    [init, segment].map(async (part) => {
      const response = await fetch(`${base}${part}`);

      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    }),
  );

  for (const part of parts) {
    expect(part.status).toBe(200);
    expect(part.bytes).toBeGreaterThan(0);
  }

  return text;
};

describe.skipIf(stack === undefined || !hasFfmpeg)(
  "the media service against a real stack",
  { timeout: 90_000 },
  () => {
    beforeAll(async () => {
      buildServiceAndCli();
      workspace = await makeTempDir("movies-media-stack-");
      fixtures = await generateFixtureLibrary(workspace);
      scope = Scope.makeUnsafe();
      owner = await Effect.runPromise(open());
      await asOwner(signInOwner);

      const profile = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.mutate("profiles.create", {
            name: `Media ${id}`,
            avatar: "red",
            kids: false,
          }),
        ),
      );

      profileId = profile.id;
      await startService();
    }, 180_000);

    afterAll(async () => {
      await asOwner(
        Effect.flatMap(client, (movies) =>
          Effect.forEach(libraries, (libraryId) =>
            movies.mutate("libraries.remove", { libraryId }).pipe(Effect.ignore),
          ),
        ),
      ).catch(() => undefined);

      await media.stop("SIGTERM");
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await removeDir(workspace);
      process.stderr.write(`media stack timings ${JSON.stringify(timings)}\n`);
    }, 60_000);

    it("scans a library an admin adds, with probe, NFO metadata, and artwork", async () => {
      const begin = performance.now();

      const created = await asOwner(
        Effect.flatMap(client, (movies) =>
          Effect.all([
            movies.mutate("libraries.create", {
              name: `Movies ${id}`,
              kind: "movies",
              roots: [fixtures.moviesRoot],
            }),
            movies.mutate("libraries.create", {
              name: `Shows ${id}`,
              kind: "shows",
              roots: [fixtures.showsRoot],
            }),
          ]),
        ),
      );

      moviesLibrary = created[0].libraryId;
      showsLibrary = created[1].libraryId;
      libraries.push(moviesLibrary, showsLibrary);

      const jobs = await asOwner(
        Effect.all(created.map((library) => finished(library.jobId, "60 seconds"))),
      );

      timings["scanMs"] = Math.round(performance.now() - begin);

      for (const job of jobs) {
        expect(job.status, job.error ?? "").toBe("succeeded");
        expect(job.progress.message).toMatch(/\d+ files/u);
      }

      const movie = await asOwner(titleIn(moviesLibrary, "Big Buck Fixture"));

      expect(movie).toMatchObject({
        kind: "movie",
        year: 2008,
        overview: "A rabbit & a test pattern.",
        certification: "PG",
        genres: ["Animation", "Comedy"],
        externalIds: { tmdb: "10378", imdb: "tt1254207" },
        available: true,
      });
      expect(movie.files[0]?.probe.container).toBe("mp4");
      expect(movie.files[0]?.probe.formatName).toContain("mp4");
      expect(movie.files[0]?.probe.video[0]).toMatchObject({
        codec: "h264",
        width: 320,
        height: 180,
      });

      const poster = movie.artwork.poster ?? "";

      expect(poster).toMatch(/^a1\./u);
      expect(poster).not.toContain("Fixture");

      const original = await fetch(artworkUrl(mediaUrl, poster));

      expect(original.status).toBe(200);
      expect(original.headers.get("content-type")).toBe("image/jpeg");

      const resized = await fetch(artworkUrl(mediaUrl, poster, 185));

      expect(resized.status).toBe(200);
      expect((await fetch(`${mediaUrl}/artwork/a1.forged`)).status).toBe(404);

      const show = await asOwner(titleIn(showsLibrary, "Fixture Show"));

      expect(show.seasons.map((season) => season.seasonNumber)).toStrictEqual([0, 1, 2]);

      const pilot = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.query("titles.episodes", { profileId, titleId: show.id, seasonNumber: 1 }),
        ),
      );

      expect(pilot[0]).toMatchObject({ episodeNumber: 1, name: "Pilot (Local)", available: true });
      expect(pilot[0]?.still).toMatch(/^a1\./u);
    });

    it("refuses a library outside LIBRARY_ROOTS on its scan job", async () => {
      const outside = await makeTempDir("movies-outside-");

      try {
        const created = await asOwner(
          Effect.flatMap(client, (movies) =>
            movies.mutate("libraries.create", {
              name: `Outside ${id}`,
              kind: "movies",
              roots: [outside],
            }),
          ),
        );

        libraries.push(created.libraryId);
        const job = await asOwner(finished(created.jobId, "30 seconds"));

        expect(job.status).toBe("failed");
        expect(job.error).toContain("Library root not approved");
      } finally {
        await removeDir(outside);
      }
    });

    it("reads chapters and makes scrub thumbnails, served only with the file's token", async () => {
      const begin = performance.now();

      const movie = await asOwner(
        Effect.gen(function* () {
          const found = yield* titleIn(moviesLibrary, "Big Buck Fixture");

          return (found.files[0]?.trickplay ?? null) === null
            ? yield* Effect.fail("not yet")
            : found;
        }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 })),
      );

      timings["trickplayAfterScanMs"] = Math.round(performance.now() - begin);

      const [file] = movie.files;
      const manifest = file?.trickplay ?? null;

      if (file === undefined || manifest === null) throw new Error("No thumbnails were recorded");

      expect(file.probe.chapters).toStrictEqual([
        { startMs: 0, endMs: 5_000, title: "Opening" },
        { startMs: 5_000, endMs: 12_000, title: "Credits" },
      ]);
      expect(manifest).toMatchObject({
        intervalMs: 10_000,
        tileWidth: 320,
        tileHeight: 180,
        thumbnailCount: 2,
        sheetCount: 1,
      });

      const started = await asOwner(startSession(movie.id, "trickplay"));
      const sheet = trickplaySheetUrl(mediaUrl, file.id, manifest, 0, started.token);
      const response = await fetch(sheet);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);

      const stored = await fetch(
        trickplayManifestUrl(mediaUrl, file.id, manifest.version, started.token),
      );

      expect(await stored.json()).toStrictEqual(manifest);

      const other = await asOwner(titleIn(moviesLibrary, "Remux Fixture"));
      const otherStarted = await asOwner(startSession(other.id, "trickplay-other"));

      expect((await fetch(sheet.replace(/\?token=.*$/u, ""))).status).toBe(401);
      expect(
        (await fetch(trickplaySheetUrl(mediaUrl, file.id, manifest, 0, otherStarted.token))).status,
      ).toBe(403);
      expect(
        (await fetch(trickplaySheetUrl(mediaUrl, file.id, { version: "0-0" }, 0, started.token)))
          .status,
      ).toBe(404);
      expect(
        (
          await fetch(
            trickplaySheetUrl(mediaUrl, file.id, manifest, manifest.sheetCount, started.token),
          )
        ).status,
      ).toBe(404);

      const jobs = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.query("jobs.list", { kind: "trickplay", status: "succeeded", limit: 100 }),
        ),
      );

      const job = jobs.find(
        (candidate) =>
          candidate.payload.kind === "trickplay" && candidate.payload.fileId === file.id,
      );

      expect(job?.progress.message).toMatch(/^2 thumbnails on 1 sheet in [\d.]+ s$/u);
    });

    it("plays a compatible file directly with byte ranges", async () => {
      const movie = await asOwner(titleIn(moviesLibrary, "Big Buck Fixture"));
      const started = await asOwner(startSession(movie.id, "direct"));
      const { stream, elapsedMs } = await negotiate(started, browser);

      timings["negotiateDirectMs"] = Math.round(elapsedMs);
      expect(stream.mode).toBe("direct");

      const begin = performance.now();
      const response = await fetch(stream.url, { headers: { range: "bytes=0-1023" } });

      timings["directTtfbMs"] = Math.round(performance.now() - begin);
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toMatch(/^bytes 0-1023\/\d+$/u);
      expect((await response.arrayBuffer()).byteLength).toBe(1024);

      const active = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.subscribe("playback.active", {}).pipe(
            Stream.filter((sessions) =>
              sessions.some(
                (session) => session.id === started.sessionId && session.mode === "direct",
              ),
            ),
            Stream.runHead,
            Effect.timeout("10 seconds"),
          ),
        ),
      );

      expect(Option.isSome(active)).toBe(true);
    });

    it("remuxes to HLS and transcodes in software when the device needs it", async () => {
      const remux = await asOwner(titleIn(moviesLibrary, "Remux Fixture"));
      const remuxStarted = await asOwner(startSession(remux.id, "remux"));
      const remuxed = await negotiate(remuxStarted, browser);

      timings["negotiateRemuxMs"] = Math.round(remuxed.elapsedMs);
      expect(remuxed.stream.mode).toBe("remux");
      expect(remuxed.stream.subtitles.map((track) => track.language)).toContain("eng");
      await fetchHls(remuxed.stream.url);

      const movie = await asOwner(titleIn(moviesLibrary, "Big Buck Fixture"));
      const transcodeStarted = await asOwner(startSession(movie.id, "transcode"));
      const transcoded = await negotiate(transcodeStarted, smallScreen);

      timings["negotiateSoftwareTranscodeMs"] = Math.round(transcoded.elapsedMs);
      expect(transcoded.stream.mode).toBe("transcode-software");
      expect(transcoded.stream.video).toMatchObject({ codec: "h264", width: 160, height: 90 });
      await fetchHls(transcoded.stream.url);
    });

    it("reports progress into continue watching, which a subscription sees", async () => {
      const movie = await asOwner(titleIn(moviesLibrary, "Big Buck Fixture"));
      const started = await asOwner(startSession(movie.id, "progress"));

      const seen = await asOwner(
        Effect.gen(function* () {
          const movies = yield* client;

          const watcher = yield* movies.subscribe("history.continueWatching", { profileId }).pipe(
            Stream.filter((items) =>
              items.some(
                (item) => item.title.id === movie.id && item.progress?.positionMs === 4_000,
              ),
            ),
            Stream.runHead,
            Effect.timeout("15 seconds"),
            Effect.forkChild,
          );

          const receipt = yield* movies.mutate("playback.reportProgress", {
            sessionId: started.sessionId,
            positionMs: Milliseconds.make(4_000),
            event: "pause",
          });

          expect(receipt).toStrictEqual({ applied: true, watched: false });

          return yield* Fiber.join(watcher);
        }),
      );

      expect(Option.isSome(seen)).toBe(true);
    });

    it("stops a stream when its playback session ends", async () => {
      const remux = await asOwner(titleIn(moviesLibrary, "Remux Fixture"));
      const started = await asOwner(startSession(remux.id, "ended"));
      const { stream } = await negotiate(started, browser);

      expect((await fetch(stream.url)).status).toBe(200);

      await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.mutate("playback.endSession", {
            sessionId: started.sessionId,
            positionMs: Milliseconds.make(1_000),
          }),
        ),
      );

      const refused = await waitForBody(
        stream.url,
        (text) => Option.getOrUndefined(decodeSessionEnded(text)),
        10_000,
      );

      expect(refused).toMatchObject({ sessionId: started.sessionId });

      const endReasons = () =>
        media
          .logs()
          .split("\n")
          .flatMap((line) => Option.toArray(decodeRecord(line)))
          .filter(
            (record) =>
              record.message === "Stream.ended" &&
              record.annotations["sessionId"] === started.sessionId,
          )
          .map((record) => record.annotations["reason"]);

      const reasons = await Effect.runPromise(
        Effect.sync(endReasons).pipe(
          Effect.repeat({
            until: (seen) => seen.length > 0,
            schedule: Schedule.spaced("100 millis"),
            times: 50,
          }),
        ),
      );

      expect(reasons).toStrictEqual(["session-ended"]);
    });

    it("refuses the first request of a session that ended before it", async () => {
      const remux = await asOwner(titleIn(moviesLibrary, "Remux Fixture"));
      const started = await asOwner(startSession(remux.id, "ended-first"));

      await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.mutate("playback.endSession", {
            sessionId: started.sessionId,
            positionMs: Milliseconds.make(0),
          }),
        ),
      );

      const response = await offer(started, browser);

      expect(response.status).toBe(410);
      expect(Option.getOrUndefined(decodeSessionEnded(await response.text()))).toMatchObject({
        sessionId: started.sessionId,
      });
    });

    it("serves metadata commands only to manage sessions and reports a missing provider", async () => {
      const movie = await asOwner(titleIn(moviesLibrary, "Big Buck Fixture"));
      const args = { titleId: movie.id, query: "Big Buck Bunny" };

      const anonymous = await fetch(`${mediaUrl}/api/metadata/candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });

      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ code: "unauthenticated" });

      const asAdmin = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.media("metadata.searchCandidates", args).pipe(Effect.flip),
        ),
      );

      expect(asAdmin.message).toContain("TMDB_API_KEY");
      expect(asAdmin).toMatchObject({ _tag: "Internal" });

      const reader = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.action("apiKeys.create", { name: `Reader ${id}`, scopes: ["read"] }),
        ),
      );

      const asReader = await Effect.runPromise(
        Effect.gen(function* () {
          const session = yield* open();

          yield* Context.get(session, Auth.Auth).signIn(
            Auth.Credentials.ApiKey({ key: Redacted.make(reader.secret) }),
          );

          return yield* Context.get(session, MoviesClient.MoviesClient)
            .media("metadata.searchCandidates", args)
            .pipe(Effect.flip);
        }),
      );

      expect(asReader).toMatchObject({ _tag: "Forbidden" });

      const refresh = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.mutate("metadata.refresh", { titleId: movie.id }),
        ),
      );

      const job = await asOwner(finished(refresh.jobId, "30 seconds"));

      expect(job.status).toBe("failed");
      expect(job.error).toContain("Metadata provider unavailable");
    });

    it("lists the folders inside LIBRARY_ROOTS for manage sessions only", async () => {
      const anonymous = await fetch(`${mediaUrl}/api/libraries/folders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      expect(anonymous.status).toBe(401);

      const roots = await asOwner(
        Effect.flatMap(client, (movies) => movies.media("libraries.folders", {})),
      );

      expect(roots.folders.map((folder) => folder.path)).toStrictEqual([workspace]);

      const inside = await asOwner(
        Effect.flatMap(client, (movies) => movies.media("libraries.folders", { path: workspace })),
      );

      expect(inside.folders.map((folder) => folder.path)).toContain(fixtures.moviesRoot);

      const outside = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.media("libraries.folders", { path: "/etc" }).pipe(Effect.flip),
        ),
      );

      expect(outside).toMatchObject({ _tag: "NotFound" });
    });

    it("does the same through the movies CLI", async () => {
      const home = await makeTempDir("movies-media-cli-");
      const env = { XDG_CONFIG_HOME: home, HOME: home };

      try {
        const login = async (email: string) =>
          (
            await runMovies(
              ["login", "--server", convexUrl, "--email", email, "--password"],
              env,
              STACK_PASSWORD,
            )
          ).code === 0;

        expect((await login(OWNER_EMAILS[0])) || (await login(OWNER_EMAILS[1]))).toBe(true);

        const scan = await runMovies(["scan", `Movies ${id}`, "--wait"], env);

        expect(scan.code, scan.stderr).toBe(0);
        expect(scan.stdout).toContain("succeeded");

        const search = await runMovies(
          ["search", "Big Buck Fixture", "--profile-id", profileId],
          env,
        );

        expect(search.code, search.stderr).toBe(0);
        expect(search.stdout).toContain("Big Buck Fixture");

        const movie = await asOwner(titleIn(moviesLibrary, "Big Buck Fixture"));
        const play = await runMovies(["play", movie.id, "--profile-id", profileId], env);

        expect(play.code, play.stderr).toBe(0);

        const played = Schema.decodeSync(
          Schema.fromJsonString(Schema.Struct({ mode: Schema.String, url: Schema.String })),
        )(play.stdout);

        expect(played.mode).toBe("direct");
        expect(ffprobeUrl(played.url)).toContain('"codec_name": "h264"');

        const progress = await runMovies(["progress", movie.id, "--profile-id", profileId], env);

        expect(progress.code, progress.stderr).toBe(0);
        expect(progress.stdout).toContain('"positionMs"');

        const resume = await runMovies(["continue", "--profile-id", profileId], env);

        expect(resume.code, resume.stderr).toBe(0);
        expect(resume.stdout).toContain(movie.id);
      } finally {
        await removeDir(home);
      }
    });

    it("keeps playback evidence in the retained log, read through the CLI, admins only", async () => {
      const remux = await asOwner(titleIn(moviesLibrary, "Remux Fixture"));
      const started = await asOwner(startSession(remux.id, "diagnosed"));
      const { stream } = await negotiate(started, browser);

      await fetchHls(stream.url);

      const playlist = new URL(stream.url);
      const pastEndSegment = await fetch(new URL(`999999.m4s${playlist.search}`, playlist));

      expect(pastEndSegment.status).toBe(404);

      const reported = await fetch(`${mediaUrl}${DIAGNOSTICS_ROUTES.clientEvents}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          encodeBatch({
            token: Redacted.make(started.token),
            platform: "web",
            events: [
              {
                ageMs: 40_000,
                observation: PlayerObservation.cases.Attached.make({
                  mode: "remux",
                  engine: "hls.js",
                }),
              },
              {
                ageMs: 31_000,
                observation: PlayerObservation.cases.BufferingStarted.make({
                  positionSeconds: 4,
                  bufferedAheadSeconds: 0,
                }),
              },
              {
                ageMs: 0,
                observation: PlayerObservation.cases.BufferingEnded.make({
                  positionSeconds: 4,
                  bufferedAheadSeconds: 6,
                  durationMs: 31_000,
                  endedBy: "playing",
                }),
              },
              {
                ageMs: 0,
                observation: PlayerObservation.cases.Recovery.make({
                  action: "renegotiate",
                  reason: "StreamNotFound",
                }),
              },
            ],
          }),
        ),
      });

      expect(reported.status).toBe(204);

      const home = await makeTempDir("movies-media-logs-");
      const env = { XDG_CONFIG_HOME: home, HOME: home };

      try {
        const login = async (email: string) =>
          (
            await runMovies(
              [
                "login",
                "--server",
                convexUrl,
                "--media-url",
                mediaUrl,
                "--email",
                email,
                "--password",
              ],
              env,
              STACK_PASSWORD,
            )
          ).code === 0;

        expect((await login(OWNER_EMAILS[0])) || (await login(OWNER_EMAILS[1]))).toBe(true);

        const logs = await runMovies(["logs", "--session-id", started.sessionId, "--json"], env);

        expect(logs.code, logs.stderr).toBe(0);

        const messages = logs.stdout
          .trim()
          .split("\n")
          .map((line) => decodeLogLine(line).message);

        expect(messages).toEqual(
          expect.arrayContaining([
            "Stream.started",
            "MediaRoutes.request_failed",
            "Player.attached",
            "Player.buffering_started",
            "Player.buffering_ended",
            "Player.recovery",
          ]),
        );

        const readable = await runMovies(
          ["logs", "--session-id", started.sessionId, "--level", "warn"],
          env,
        );

        expect(readable.code, readable.stderr).toBe(0);
        expect(readable.stdout).toMatch(/WARN {2}MediaRoutes\.request_failed .*status=404/u);
        expect(readable.stdout).not.toContain('{"message"');

        const timeline = await runMovies(["diagnostics", "playback", started.sessionId], env);

        expect(timeline.code, timeline.stderr).toBe(0);

        const diagnostics = decodeDiagnostics(timeline.stdout);

        expect(diagnostics.entries.map((entry) => entry.kind)).toEqual(
          expect.arrayContaining([
            "stream-started",
            "player-attached",
            "buffering-started",
            "buffering-ended",
            "request-failed",
            "recovery",
          ]),
        );
        expect(diagnostics.counts).toMatchObject({
          streams: 1,
          stalls: 1,
          stalledMs: 31_000,
          failedRequests: 1,
          recoveries: 1,
        });
        expect(diagnostics.drift.status).toBe("not-measured");
        expect(diagnostics.platform).toBe("web");

        const sessions = await runMovies(["diagnostics", "sessions", "--human"], env);

        expect(sessions.code, sessions.stderr).toBe(0);
        expect(sessions.stdout).toContain(started.sessionId);
      } finally {
        await removeDir(home);
      }

      const email = `media-member-${id}@movies.test`;

      const invite = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.action("invites.create", { email, role: "member" }),
        ),
      );

      const refused = await Effect.runPromise(
        Effect.gen(function* () {
          const session = yield* open();
          const movies = Context.get(session, MoviesClient.MoviesClient);

          yield* Context.get(session, Auth.Auth).signIn(
            Auth.Credentials.Password({
              flow: "signUp",
              email,
              password: Redacted.make(STACK_PASSWORD),
              name: Option.none(),
              inviteCode: Option.some(invite.code),
            }),
          );

          return {
            logs: yield* movies.logs({}).pipe(Effect.flip),
            timeline: yield* movies
              .media("diagnostics.playback", { sessionId: started.sessionId })
              .pipe(Effect.flip),
          };
        }),
      );

      expect(refused.logs).toMatchObject({ _tag: "Forbidden" });
      expect(refused.timeline).toMatchObject({ _tag: "NotFound" });
    });

    it("recovers a job whose worker died once the lease expires", async () => {
      await media.stop("SIGKILL");

      const queued = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.mutate("libraries.scan", { libraryId: showsLibrary }),
        ),
      );

      const crashed = await Effect.runPromise(
        Effect.gen(function* () {
          const session = yield* open();
          const auth = Context.get(session, Auth.Auth);
          const transport = Context.get(session, ConvexTransport.ConvexTransport);

          yield* auth.signIn(
            Auth.Credentials.ApiKey({ key: Redacted.make(stack?.mediaServiceKey ?? "") }),
          );

          return yield* transport.call("mutation", "mediaService:claimJob", {
            jobId: queued.jobId,
            workerId: "crashed-worker",
            leaseMs: 5_000,
          });
        }),
      );

      expect(crashed).not.toBeNull();

      await startService();
      const begin = performance.now();
      const job = await asOwner(finished(queued.jobId, "150 seconds"));

      timings["leaseRecoveryMs"] = Math.round(performance.now() - begin);
      expect(job.status).toBe("succeeded");
      expect(job.attempts).toBe(2);
    }, 180_000);

    it("refuses the tokens of sessions a restore ends or erases", async () => {
      const listBackups = () =>
        asOwner(Effect.flatMap(client, (movies) => movies.query("backups.list", {})));

      const remux = await asOwner(titleIn(moviesLibrary, "Remux Fixture"));
      const kept = await asOwner(startSession(remux.id, "restore-kept"));

      await negotiate(kept, browser);

      const earlier = new Set((await listBackups()).map((backup) => backup.id));

      const backup = await asOwner(
        Effect.gen(function* () {
          const movies = yield* client;
          const { jobId } = yield* movies.mutate("backups.run", {});

          return yield* finished(jobId, "90 seconds");
        }),
      );

      expect(backup.status, backup.error ?? "").toBe("succeeded");

      const erased = await asOwner(startSession(remux.id, "restore-erased"));

      await negotiate(erased, browser);

      const taken =
        (await listBackups()).find((listed) => !earlier.has(listed.id)) ?? expect.unreachable();

      await asOwner(
        Effect.flatMap(client, (movies) => movies.media("backups.restore", { backupId: taken.id })),
      );

      owner = await Effect.runPromise(open());
      await asOwner(signInOwner);
      await connected();

      await expect
        .poll(
          () =>
            Promise.all(
              [kept, erased].map(async (started) => (await offer(started, browser)).status),
            ),
          { timeout: 45_000, interval: 1_000 },
        )
        .toStrictEqual([410, 410]);
    }, 180_000);
  },
);

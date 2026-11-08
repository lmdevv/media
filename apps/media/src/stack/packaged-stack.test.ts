import { DeviceId } from "@media/contracts/ids";
import type { LibraryId, ProfileId, TitleId } from "@media/contracts/ids";
import {
  type ClientCapabilities,
  HealthResponse,
  MEDIA_ROUTES,
  NegotiateRequest,
  NegotiateResponse,
} from "@media/contracts/media-playback";
import { Auth } from "@media/sdk/effect";
import { Effect, Exit, Option, Redacted, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  client,
  finished,
  openSession,
  runIn,
  STACK_PASSWORD,
  type StackSession,
} from "../testing/stack-owner.ts";
import {
  makeTempDir,
  removeDir,
  runCommand,
  runMovies,
  waitForBody,
} from "../testing/stack-processes.ts";

const enabled = process.env["MEDIA_PACKAGED_STACK"] === "1";

const convexUrl = process.env["MEDIA_PACKAGED_CONVEX_URL"] ?? "";

const mediaUrl = process.env["MEDIA_PACKAGED_SERVER_URL"] ?? "";

const libraryDir = process.env["MEDIA_PACKAGED_LIBRARY"] ?? "/media/library";

const restartCommand = (process.env["MEDIA_PACKAGED_RESTART"] ?? "").split(" ").filter(Boolean);

const OWNER = "owner@movies.test";

const browser: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
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

let profileId: ProfileId;

let libraryId: LibraryId;

let movieId: TitleId;

const decodeHealth = Schema.decodeUnknownOption(Schema.fromJsonString(HealthResponse));

const encodeNegotiate = Schema.encodeSync(Schema.toCodecJson(NegotiateRequest));

const decodeNegotiated = Schema.decodeUnknownSync(Schema.toCodecJson(NegotiateResponse));

const decodeStreamNotFound = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.TaggedStruct("StreamNotFound", {})),
);

const connected = () =>
  waitForBody(
    `${mediaUrl}${MEDIA_ROUTES.health}`,
    (text) =>
      decodeHealth(text).pipe(
        Option.filter((health) => health.backend === "connected"),
        Option.getOrUndefined,
      ),
    120_000,
  );

const session = () => Effect.runPromise(openSession(convexUrl, mediaUrl, scope));

const password = (flow: "signIn" | "signUp") =>
  Auth.Credentials.Password({
    flow,
    email: OWNER,
    password: Redacted.make(STACK_PASSWORD),
    name: Option.some("Owner"),
    inviteCode: Option.none(),
  });

const signIn = async (flow: "signIn" | "signUp"): Promise<StackSession> => {
  const opened = await session();

  await runIn(
    opened,
    Effect.gen(function* () {
      const auth = yield* Auth.Auth;

      yield* auth.signIn(password(flow));
    }),
  );

  return opened;
};

const play = async (capabilities: ClientCapabilities, device: string) => {
  const started = await runIn(
    owner,
    Effect.flatMap(client, (movies) =>
      movies.mutate("playback.createSession", {
        profileId,
        deviceId: DeviceId.make(`packaged-${device}`),
        titleId: movieId,
      }),
    ),
  );

  const response = await fetch(`${started.mediaBaseUrl}${MEDIA_ROUTES.negotiate}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      encodeNegotiate({ token: Redacted.make(started.token), capabilities, startSeconds: 0 }),
    ),
  });

  const body: unknown = await response.json();

  expect(response.status, JSON.stringify(body)).toBe(200);

  return decodeNegotiated(body);
};

describe.skipIf(!enabled)("the packaged install", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    scope = Scope.makeUnsafe();
    await connected();
    owner = await signIn("signUp");

    const profile = await runIn(
      owner,
      Effect.flatMap(client, (movies) =>
        movies.mutate("profiles.create", { name: "Packaged", avatar: "red", kids: false }),
      ),
    );

    profileId = profile.id;
  }, 180_000);

  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("serves the movies client pointed at the deployment", async () => {
    const index = await fetch(`${mediaUrl}/movies/`);
    const html = await index.text();

    expect(index.status).toBe(200);
    const script = /src="(\/movies\/assets\/index-[^"]+\.js)"/u.exec(html)?.[1] ?? "";
    const bundle = await (await fetch(`${mediaUrl}${script}`)).text();

    expect(bundle).toContain(convexUrl);
    expect(bundle).not.toContain("__MEDIA_CONVEX_URL__");
  });

  it("scans a read-only library an admin adds", async () => {
    const created = await runIn(
      owner,
      Effect.flatMap(client, (movies) =>
        movies.mutate("libraries.create", {
          name: "Movies",
          kind: "movies",
          roots: [`${libraryDir}/movies`],
        }),
      ),
    );

    libraryId = created.libraryId;
    const job = await runIn(owner, finished(created.jobId, "120 seconds"));

    expect(job.status, job.error ?? "").toBe("succeeded");

    const found = await runIn(
      owner,
      Effect.flatMap(client, (movies) =>
        movies.query("titles.search", { profileId, query: "Big Buck Fixture", limit: 5 }),
      ),
    );

    movieId = found[0]?.id ?? expect.unreachable();
    expect(libraryId).toBeDefined();
  });

  it("plays directly with byte ranges and through HLS", async () => {
    const direct = await play(browser, "direct");

    expect(direct.mode).toBe("direct");

    const range = await fetch(direct.url, { headers: { range: "bytes=0-1023" } });

    expect(range.status).toBe(206);
    expect((await range.arrayBuffer()).byteLength).toBe(1024);

    const hls = await play(smallScreen, "hls");
    const playlist = await fetch(hls.url);

    expect(playlist.status).toBe(200);
    expect(await playlist.text()).toContain("#EXTM3U");
  });

  it("answers a typed error for a stream lost in a restart, then plays again", async () => {
    const hls = await play(smallScreen, "restart");

    expect((await fetch(hls.url)).status).toBe(200);
    runCommand(restartCommand);
    await connected();

    const lost = await fetch(hls.url);

    expect(lost.status).toBeGreaterThanOrEqual(400);
    expect(Option.isSome(decodeStreamNotFound(await lost.text()))).toBe(true);

    const again = await play(smallScreen, "restart-again");

    expect((await fetch(again.url)).status).toBe(200);
  });

  it("backs up and restores through the CLI; everyone signs in again", async () => {
    const home = await makeTempDir("movies-packaged-cli-");
    const env = { XDG_CONFIG_HOME: home, HOME: home };

    try {
      const login = await runMovies(
        ["login", "--server", convexUrl, "--media-url", mediaUrl, "--email", OWNER, "--password"],
        env,
        STACK_PASSWORD,
      );

      expect(login.code, login.stderr).toBe(0);

      const backup = await runMovies(["backup", "--wait"], env);

      expect(backup.code, backup.stderr).toBe(0);
      expect(backup.stdout).toContain("succeeded");

      const backups = await runIn(
        owner,
        Effect.flatMap(client, (movies) => movies.query("backups.list", {})),
      );

      const archive = backups[0] ?? expect.unreachable();

      await runIn(
        owner,
        Effect.flatMap(client, (movies) => movies.mutate("libraries.remove", { libraryId })),
      );

      const restore = await runMovies(["restore", archive.fileName], env);

      expect(restore.code, restore.stderr).toBe(0);

      const stale = await runIn(
        owner,
        Effect.flatMap(client, (movies) => movies.query("libraries.list", {})).pipe(Effect.exit),
      );

      expect(Exit.isFailure(stale)).toBe(true);
      owner = await signIn("signIn");

      const libraries = await runIn(
        owner,
        Effect.flatMap(client, (movies) => movies.query("libraries.list", {})),
      );

      expect(libraries.map((library) => library.id)).toContain(libraryId);
      await connected();
      expect((await play(browser, "after-restore")).mode).toBe("direct");
    } finally {
      await removeDir(home);
    }
  });
});

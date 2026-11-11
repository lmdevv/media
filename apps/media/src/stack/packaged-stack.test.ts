import { BackupId } from "@media/contracts/ids";
import {
  type ClientCapabilities,
  HealthResponse,
  MEDIA_ROUTES,
  NegotiateRequest,
  NegotiateResponse,
} from "@media/contracts/media-playback";
import { Platform, TokenStorage } from "@media/sdk/effect";
import { createMediaServer } from "@media/sdk/promise";
import { Context, Effect, Exit, Layer, Option, Redacted, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCommand, waitForBody } from "../testing/stack-processes.ts";

const enabled = process.env["MEDIA_PACKAGED_STACK"] === "1";

const convexUrl = process.env["MEDIA_PACKAGED_CONVEX_URL"] ?? "";

const mediaUrl = process.env["MEDIA_PACKAGED_SERVER_URL"] ?? "";

const libraryDir = process.env["MEDIA_PACKAGED_LIBRARY"] ?? "/media/library";

const restartCommand = (process.env["MEDIA_PACKAGED_RESTART"] ?? "").split(" ").filter(Boolean);

/** The owner the install is set up with; scripts/stack-e2e.sh signs its CLI in as them. */
const OWNER = process.env["MEDIA_PACKAGED_OWNER"] ?? "owner";

const PASSWORD = process.env["MEDIA_PACKAGED_PASSWORD"] ?? "stack-test-password";

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

let owner: Platform.Interface;

let libraryId: Option.Option<Platform.Id<"libraries">> = Option.none();

let movieId: Option.Option<Platform.Id<"titles">> = Option.none();

const library = (): Platform.Id<"libraries"> =>
  Option.getOrThrowWith(libraryId, () => new Error("The library was not created"));

const movie = (): Platform.Id<"titles"> =>
  Option.getOrThrowWith(movieId, () => new Error("The scan found no Big Buck Fixture"));

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

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

/** A script name the movies client's bundles name, as `./x.js` or `assets/x.js`. */
const SCRIPT_REFERENCE = /(?:\.\/|assets\/)([\w.-]+\.js)/gu;

/**
 * The movies client's entry script `entry` and every script it reaches, joined: the bundler moves
 * shared modules, such as the client's settings, into chunks the entry imports.
 */
const moviesScripts = async (entry: string): Promise<string> => {
  const seen = new Set<string>();

  const visit = async (name: string): Promise<string> => {
    if (seen.has(name)) return "";

    seen.add(name);

    const text = await (await fetch(`${mediaUrl}/movies/assets/${name}`)).text();

    const reached = await Promise.all(
      [...text.matchAll(SCRIPT_REFERENCE)].flatMap(([, reference]) =>
        reference === undefined ? [] : [visit(reference)],
      ),
    );

    return [text, ...reached].join("\n");
  };

  return visit(entry);
};

const eventually = <A>(
  what: string,
  check: () => Promise<Option.Option<A>>,
  timeoutMs: number,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs;

  const attempt = async (): Promise<A> => {
    const found = await check();

    if (Option.isSome(found)) return found.value;

    if (Date.now() > deadline) throw new Error(`Timed out after ${String(timeoutMs)} ms: ${what}`);

    await new Promise((resolve) => setTimeout(resolve, 500));

    return attempt();
  };

  return attempt();
};

const signIn = (credentials: Platform.Credentials): Promise<Platform.Interface> =>
  run(
    Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(
        Platform.layer({
          url: convexUrl,
          connection: "http",
          storage: TokenStorage.layerMemory,
          signIn: Platform.SignInRoute.Boundary({ url: Platform.signInUrlBeside(convexUrl) }),
        }),
        scope,
      );

      const platform = Context.get(context, Platform.Platform);

      yield* platform.session.signIn(credentials);

      return platform;
    }),
  );

const password = () =>
  Platform.Credentials.Password({ username: OWNER, password: Redacted.make(PASSWORD) });

const mediaServer = (platform: Platform.Interface) =>
  createMediaServer({
    url: mediaUrl,
    accessToken: () =>
      run(
        platform.session.accessToken.pipe(
          Effect.map(Option.match({ onNone: () => null, onSome: Redacted.value })),
        ),
      ),
  });

const scanned = (platform: Platform.Interface, id: Platform.Id<"libraries">) =>
  eventually(
    "the library's scan ends",
    async () => {
      const status = (await run(platform.core.libraries.get({ libraryId: id }))).scan?.status;

      return status === "succeeded" || status === "failed" ? Option.some(status) : Option.none();
    },
    120_000,
  );

const play = async (capabilities: ClientCapabilities) => {
  const started = await run(owner.movies.play.start({ titleId: movie() }));

  const response = await fetch(`${mediaUrl}${MEDIA_ROUTES.negotiate}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      encodeNegotiate({ token: Redacted.make(started.ticket), capabilities, startSeconds: 0 }),
    ),
  });

  const body: unknown = await response.json();

  expect(response.status, JSON.stringify(body)).toBe(200);

  return decodeNegotiated(body);
};

const backups = (platform: Platform.Interface) =>
  run(platform.core.server.backups.list({ paginationOpts: { numItems: 50, cursor: null } })).then(
    (page) => page.page,
  );

describe.skipIf(!enabled)("the packaged install", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    scope = await run(Scope.make());
    await connected();

    const info = await run(
      Effect.gen(function* () {
        const context = yield* Layer.buildWithScope(
          Platform.layer({
            url: convexUrl,
            connection: "http",
            storage: TokenStorage.layerMemory,
            signIn: Platform.SignInRoute.Boundary({ url: Platform.signInUrlBeside(convexUrl) }),
          }),
          scope,
        );

        return yield* Context.get(context, Platform.Platform).core.server.info();
      }),
    );

    owner = await signIn(
      info.hasOwner
        ? password()
        : Platform.Credentials.Setup({ username: OWNER, password: Redacted.make(PASSWORD) }),
    );
  }, 180_000);

  afterAll(async () => {
    await run(Scope.close(scope, Exit.void));
  });

  it("signs the owner in on the core at /convex", async () => {
    const session = await run(owner.core.auth.sessions.current());

    expect(session.username).toBe(OWNER);
    expect(session.role).toBe("owner");
  });

  it("answers Not Found at old movies' Convex path", async () => {
    const answers = await Promise.all(
      ["/movies/convex", "/movies/convex/version"].map(async (path) => {
        const response = await fetch(`${mediaUrl}${path}`);

        return { path, status: response.status, body: await response.text() };
      }),
    );

    for (const answer of answers) {
      expect(answer.status, answer.path).toBe(404);
      expect(answer.body, answer.path).not.toContain("<html");
    }
  });

  it("serves the movies client pointed at the core", async () => {
    const index = await fetch(`${mediaUrl}/movies/`);
    const html = await index.text();

    expect(index.status).toBe(200);
    const script = /src="\/movies\/assets\/(index-[^"]+\.js)"/u.exec(html)?.[1] ?? "";
    const bundle = await moviesScripts(script);

    expect(script).not.toBe("");
    expect(bundle).toContain(convexUrl);
    expect(bundle).not.toContain(`${mediaUrl}/movies/convex`);
    expect(bundle).not.toContain("__MEDIA_CONVEX_URL__");
  });

  it("scans a read-only library the owner adds into the core", async () => {
    const created = await run(
      owner.core.libraries.create({
        name: "Movies",
        kind: "movies",
        folders: [`${libraryDir}/movies`],
      }),
    );

    libraryId = Option.some(created.libraryId);
    expect(await scanned(owner, created.libraryId)).toBe("succeeded");

    const found = await run(owner.movies.titles.search({ query: "Big Buck Fixture", limit: 5 }));

    movieId = Option.fromNullishOr(found.find((title) => title.name === "Big Buck Fixture")?.id);
    expect(Option.isSome(movieId)).toBe(true);
  });

  it("plays a ticket from movies.play.start directly with byte ranges and through HLS", async () => {
    const direct = await play(browser);

    expect(direct.mode).toBe("direct");
    expect(direct.url).toContain("ticket=");

    const range = await fetch(direct.url, { headers: { range: "bytes=0-1023" } });

    expect(range.status).toBe(206);
    expect((await range.arrayBuffer()).byteLength).toBe(1024);

    const hls = await play(smallScreen);
    const playlist = await fetch(hls.url);

    expect(playlist.status).toBe(200);
    expect(await playlist.text()).toContain("#EXTM3U");
  });

  it("answers a typed error for a stream lost in a restart, then plays again", async () => {
    const hls = await play(smallScreen);

    expect((await fetch(hls.url)).status).toBe(200);
    runCommand(restartCommand);
    await connected();

    const lost = await fetch(hls.url);

    expect(lost.status).toBeGreaterThanOrEqual(400);
    expect(Option.isSome(decodeStreamNotFound(await lost.text()))).toBe(true);

    const again = await play(smallScreen);

    expect((await fetch(again.url)).status).toBe(200);
  });

  it("backs the core up and restores it through the media server", async () => {
    const before = new Set((await backups(owner)).map((archive) => archive.fileName));

    await run(owner.core.server.backups.run());

    const archive = await eventually(
      "the backup is listed",
      async () =>
        Option.fromNullishOr((await backups(owner)).find((found) => !before.has(found.fileName))),
      120_000,
    );

    await run(owner.core.libraries.remove({ libraryId: library() }));
    await mediaServer(owner).run("backups.restore", { backupId: BackupId.make(archive.id) });

    const restored = await eventually(
      "the restored core answers",
      async () => {
        const fresh = await signIn(password()).catch(() => null);

        return Option.fromNullishOr(fresh);
      },
      120_000,
    );

    const libraries = await run(
      restored.core.libraries.list({ paginationOpts: { numItems: 50, cursor: null } }),
    );

    expect(libraries.page.map((found) => found.libraryId)).toContain(library());
    owner = restored;
    await connected();
    expect((await play(browser)).mode).toBe("direct");
  });
});

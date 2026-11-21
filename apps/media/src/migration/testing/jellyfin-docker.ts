import { hostname } from "node:os";

import { NodeServices } from "@effect/platform-node";
import {
  Crypto,
  Duration,
  Effect,
  Layer,
  Predicate,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { generateFixtureLibrary } from "../../testing/fixture-library.ts";
import type { FixtureLibrary } from "../../testing/fixture-library.ts";
import { camelCaseKeys } from "../source-http.ts";

const JELLYFIN_IMAGE =
  process.env["JELLYFIN_IMAGE"] ??
  "jellyfin/jellyfin:12.2@sha256:357724bf0ae27a672c7cbaa899db2d9abeb13dbd8657ccce750258a4c059d037";

/** A running, set-up Jellyfin. */
export interface JellyfinServer {
  readonly url: string;
  readonly apiKey: string;
  /** The users' passwords, random for each server. */
  readonly passwords: { readonly admin: string; readonly bob: string };
  readonly version: string;
  readonly library: FixtureLibrary;
  /** The mounted fixture folder on this host; Jellyfin sees it as `/media`. */
  readonly hostRoot: string;
  readonly ids: {
    readonly admin: string;
    readonly bob: string;
    readonly bigBuck: string;
    readonly remux: string;
    readonly pilot: string;
    readonly show: string;
    readonly boxSet: string;
  };
}

class JellyfinSetupFailed extends Schema.TaggedError<
  JellyfinSetupFailed,
  { readonly brand: unique symbol }
>()("JellyfinSetupFailed", {
  step: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Jellyfin setup failed: ${this.step}`;
  }
}

const CLIENT =
  'MediaBrowser Client="media-test", Device="test", DeviceId="media-test", Version="1.0"';

const docker = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const step = `docker ${args[0] ?? ""}`;
  const fail = (cause: unknown) => new JellyfinSetupFailed({ step, cause });

  const handle = yield* spawner
    .spawn(ChildProcess.make("docker", args, { stdin: "ignore" }))
    .pipe(Effect.mapError(fail));

  const [stdout, stderr] = yield* Effect.all(
    [
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ],
    { concurrency: 2 },
  ).pipe(Effect.mapError(fail));

  const code = yield* handle.exitCode.pipe(Effect.mapError(fail));

  if (code !== ChildProcessSpawner.ExitCode(0)) return yield* fail(stderr.trim());

  return stdout.trim();
}, Effect.scoped);

const jellyfinAvailable: Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =
  docker(["image", "inspect", JELLYFIN_IMAGE]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const JsonText = Schema.fromJsonString(Schema.Json);

const apiFor = (client: HttpClient.HttpClient, url: string, token: string | null) => {
  const authorization = token === null ? CLIENT : `${CLIENT}, Token="${token}"`;

  const call = <S extends Schema.Codec<unknown, unknown>>(
    method: "GET" | "POST",
    path: string,
    schema: S,
    body: Schema.Json = null,
  ): Effect.Effect<S["Type"], JellyfinSetupFailed> => {
    const request = HttpClientRequest.make(method)(`${url}${path}`).pipe(
      HttpClientRequest.setHeader("authorization", authorization),
      method === "POST" && body !== null
        ? HttpClientRequest.bodyJsonUnsafe(body)
        : HttpClientRequest.setHeader("content-type", "application/json"),
    );

    return client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.flatMap((text) =>
        text === "" ? Effect.succeed(null) : Schema.decodeEffect(JsonText)(text),
      ),
      Effect.flatMap((json) =>
        Schema.decodeEffect(schema)(json === null ? null : camelCaseKeys(json)),
      ),
      Effect.mapError((cause) => new JellyfinSetupFailed({ step: `${method} ${path}`, cause })),
    );
  };

  return {
    get: <S extends Schema.Codec<unknown, unknown>>(path: string, schema: S) =>
      call("GET", path, schema),
    post: <S extends Schema.Codec<unknown, unknown>>(path: string, schema: S, body?: Schema.Json) =>
      call("POST", path, schema, body),
    send: (path: string, body?: Schema.Json) =>
      call("POST", path, Schema.Unknown, body).pipe(Effect.asVoid),
  };
};

/** Retries `effect` every second for two minutes: Jellyfin answers before it finishes starting. */
const patiently = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced(Duration.seconds(1)), times: 120 }));

const PublicInfo = Schema.Struct({ version: Schema.String });

const Session = Schema.Struct({
  accessToken: Schema.String,
  user: Schema.Struct({ id: Schema.String }),
});

const Keys = Schema.Struct({ items: Schema.Array(Schema.Struct({ accessToken: Schema.String })) });

const Items = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String }),
  ),
});

const Created = Schema.Struct({ id: Schema.String });

/** An item as `GET /Items/{id}` returns it, whole, so an update sends every field back. */
const ItemDto = Schema.Record(Schema.String, Schema.Json);

const LIBRARIES = [
  ["Movies", "movies", "/media/movies"],
  ["Shows", "tvshows", "/media/shows"],
] as const;

const CONTAINER_PREFIX = "media-jellyfin-test-";

const ORPHAN_AGE_MS = 10 * 60 * 1000;

/**
 * The Docker label naming the host whose test process started a container. Another PID namespace
 * on the same daemon (a dev container, a CI job) has another hostname, so its containers are never
 * judged by this host's process list.
 */
const HOST_LABEL = "movies.test.host";

/** Whether process `pid` still runs on this host: signal 0 checks without sending anything. */
const isRunning = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);

      return true;
    } catch (cause) {
      return !(Predicate.hasProperty(cause, "code") && cause.code === "ESRCH");
    }
  });

const removeLeftovers = Effect.fnUntraced(function* () {
  const names = yield* docker([
    "ps",
    "--all",
    "--filter",
    `name=^${CONTAINER_PREFIX}`,
    "--filter",
    `label=${HOST_LABEL}=${hostname()}`,
    "--format",
    "{{.Names}}",
  ]);

  const now = Date.now();

  yield* Effect.forEach(
    names.split("\n").filter((name) => name.startsWith(CONTAINER_PREFIX)),
    (name) =>
      Effect.gen(function* () {
        const [pid, started] = name.slice(CONTAINER_PREFIX.length).split("-").map(Number);

        if (pid === undefined || started === undefined || now - started < ORPHAN_AGE_MS) return;

        if (yield* isRunning(pid)) return;

        yield* docker(["rm", "-f", name]).pipe(Effect.ignore);
      }),
    { discard: true },
  );
});

const FIXTURE_ITEMS = 11;

/**
 * Starts Jellyfin over a fresh fixture library under `workspace` and sets it up. The container is
 * removed when the scope closes.
 */
export const startJellyfin = Effect.fn("JellyfinDocker.start")(function* (workspace: string) {
  const client = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;

  const randomPassword = crypto.randomBytes(18).pipe(
    Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
    Effect.orDie,
  );

  const passwords = { admin: yield* randomPassword, bob: yield* randomPassword };

  const library = yield* Effect.tryPromise({
    try: () => generateFixtureLibrary(workspace),
    catch: (cause) => new JellyfinSetupFailed({ step: "generate the fixture library", cause }),
  });

  yield* removeLeftovers().pipe(Effect.ignore);

  const name = `${CONTAINER_PREFIX}${String(process.pid)}-${String(Date.now())}`;

  yield* Effect.acquireRelease(
    docker([
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--label",
      `${HOST_LABEL}=${hostname()}`,
      "--hostname",
      "jellyfin-fixture",
      "-p",
      "127.0.0.1::8096",
      "-v",
      `${workspace}:/media:ro`,
      JELLYFIN_IMAGE,
    ]),
    () => docker(["rm", "-f", name]).pipe(Effect.ignore),
  );

  const port = yield* docker(["port", name, "8096/tcp"]);
  const url = `http://${port.split("\n")[0] ?? ""}`;
  const anonymous = apiFor(client, url, null);
  const { version } = yield* patiently(anonymous.get("/System/Info/Public", PublicInfo));

  yield* patiently(
    anonymous.send("/Startup/Configuration", {
      UICulture: "en-US",
      MetadataCountryCode: "US",
      PreferredMetadataLanguage: "en",
    }),
  );
  yield* patiently(anonymous.get("/Startup/User", Schema.Unknown));
  yield* patiently(anonymous.send("/Startup/User", { Name: "admin", Password: passwords.admin }));

  yield* patiently(
    anonymous.send("/Startup/RemoteAccess", {
      EnableRemoteAccess: true,
      EnableAutomaticPortMapping: false,
    }),
  );
  yield* patiently(anonymous.send("/Startup/Complete"));

  const session = yield* anonymous.post("/Users/AuthenticateByName", Session, {
    Username: "admin",
    Pw: passwords.admin,
  });

  const admin = session.user.id;
  const api = apiFor(client, url, session.accessToken);

  yield* api.send("/Auth/Keys?app=movies-test");
  const [key] = (yield* api.get("/Auth/Keys", Keys)).items;

  if (key === undefined) {
    return yield* new JellyfinSetupFailed({ step: "create an API key", cause: null });
  }

  yield* Effect.forEach(LIBRARIES, ([libraryName, type, path]) =>
    api.send(
      `/Library/VirtualFolders?name=${libraryName}&collectionType=${type}&paths=${encodeURIComponent(path)}&refreshLibrary=false`,
      { LibraryOptions: {} },
    ),
  );

  // One refresh for both libraries: a second refresh can cancel the first one's scan.
  yield* api.send("/Library/Refresh");

  const scanned = api
    .get("/Items?Recursive=true&IncludeItemTypes=Movie,Series,Episode", Items)
    .pipe(
      Effect.filterOrFail(
        (found) => found.items.length >= FIXTURE_ITEMS,
        () => new JellyfinSetupFailed({ step: "scan the fixture library", cause: null }),
      ),
    );

  const { items } = yield* patiently(scanned);

  const find = (type: string, start: string) => {
    const found = items.find((item) => item.type === type && item.name.startsWith(start));

    return found === undefined
      ? Effect.fail(new JellyfinSetupFailed({ step: `find ${start}`, cause: null }))
      : Effect.succeed(found.id);
  };

  const ids = yield* Effect.all({
    bigBuck: find("Movie", "Big Buck Fixture"),
    remux: find("Movie", "Remux Fixture"),
    pilot: find("Episode", "Pilot"),
    show: find("Series", "Fixture Show"),
  });

  const bob = (yield* api.post("/Users/New", Created, { Name: "bob", Password: passwords.bob })).id;

  yield* api.send(`/UserPlayedItems/${ids.bigBuck}?userId=${admin}`);

  yield* api.send(`/UserItems/${ids.remux}/UserData?userId=${admin}`, {
    PlaybackPositionTicks: 60_000_000,
    LastPlayedDate: "2026-10-01T20:00:00Z",
  });

  yield* api.send(`/UserFavoriteItems/${ids.show}?userId=${admin}`);
  yield* api.send(`/UserPlayedItems/${ids.pilot}?userId=${bob}`);
  const boxSet = (yield* api.post("/Collections?Name=Fixture%20Box", Created)).id;
  yield* api.send(`/Collections/${boxSet}/Items?ids=${ids.bigBuck},${ids.remux}`);

  // `GET /Items/{id}` answers PascalCase; send it back as is with the locked fields changed.
  const dto = yield* client
    .execute(
      HttpClientRequest.get(`${url}/Items/${ids.bigBuck}?userId=${admin}`).pipe(
        HttpClientRequest.setHeader("authorization", `${CLIENT}, Token="${session.accessToken}"`),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ItemDto))),
      Effect.mapError((cause) => new JellyfinSetupFailed({ step: "read the movie", cause })),
    );

  yield* api.send(`/Items/${ids.bigBuck}`, {
    ...dto,
    Name: "Big Buck Fixture (Director's Cut)",
    ForcedSortName: "Fixture, Big Buck",
    LockData: true,
    LockedFields: ["Name"],
  });

  const server: JellyfinServer = {
    url,
    apiKey: key.accessToken,
    passwords,
    version,
    library,
    hostRoot: workspace,
    ids: { ...ids, admin, bob, boxSet },
  };

  return server;
});

type Platform =
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | NodeServices.NodeServices
  | Scope.Scope;

const onNode = <A, E>(effect: Effect.Effect<A, E, Platform>): Effect.Effect<A, E, Scope.Scope> =>
  Effect.gen(function* () {
    const platform = yield* Layer.build(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer));

    return yield* effect.pipe(Effect.provideContext(platform));
  });

/** Runs `effect` on Node for suites outside Effect; what it acquires lives until `scope` closes. */
export const runOnNode = <A, E>(
  scope: Scope.Scope,
  effect: Effect.Effect<A, E, Platform>,
): Promise<A> => Effect.runPromise(onNode(effect).pipe(Scope.provide(scope)));

/** Whether Docker has the Jellyfin image here, for suites outside Effect. */
export const jellyfinImageAvailable = (): Promise<boolean> =>
  Effect.runPromise(Effect.scoped(onNode(jellyfinAvailable)));

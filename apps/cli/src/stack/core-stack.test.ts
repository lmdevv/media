import { serverFunctions } from "@media/contracts/server-functions";
import type { ServerReport } from "@media/contracts/server-functions";
import { EpochMillis } from "@media/contracts/units";
import { Platform, TokenStorage } from "@media/sdk/effect";
import { ownClientFetch, startOwnClientProxy } from "@media/sdk/testing/own-client";
import type { OwnClientProxy } from "@media/sdk/testing/own-client";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { join } from "node:path";

import { ExitCode } from "../cli-errors";
import { withMediaService } from "../testing/media-service";
import {
  buildCli,
  listTree,
  makeTempDir,
  permissions,
  readText,
  removeDir,
  runCli,
  startCli,
  writeExecutable,
} from "../testing/process";
import { findCoreStack } from "../testing/stack-env";

const core = findCoreStack();

const url = core?.url ?? "";

const envFile = core?.envFile ?? "";

const PASSWORD = "core-stack-password";

const id = Math.random().toString(36).slice(2, 8);

const homes: Array<string> = [];

/**
 * The stack's boundary through a proxy that names each sign-in as a client of its own, as Caddy
 * names each client, so the suite's sign-ins never share one address's budget.
 */
let proxy: OwnClientProxy | undefined;

const install = async (): Promise<Readonly<Record<string, string>>> => {
  const home = await makeTempDir("media-core-stack-");

  homes.push(home);

  return { XDG_CONFIG_HOME: home, HOME: home, MEDIA_CORE_SIGN_IN_URL: proxy?.url ?? "" };
};

const parse =
  <A>(schema: Schema.Codec<A, unknown>) =>
  (stdout: string): A =>
    Schema.decodeSync(Schema.fromJsonString(schema))(stdout);

const Info = parse(Schema.Struct({ hasOwner: Schema.Boolean }));

const Reset = parse(Schema.Struct({ username: Schema.String }));

const Users = parse(
  Schema.Struct({
    page: Schema.Array(Schema.Struct({ username: Schema.String, role: Schema.String })),
  }),
);

const Session = parse(Schema.Struct({ username: Schema.String, kind: Schema.String }));

const SignedIn = parse(
  Schema.Struct({ session: Schema.Struct({ username: Schema.String, kind: Schema.String }) }),
);

const Titles = parse(
  Schema.Struct({ page: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })) }),
);

const Streamed = parse(
  Schema.Struct({ title: Schema.String, url: Schema.String, mode: Schema.String }),
);

const Seeded = parse(
  Schema.Struct({
    status: Schema.Literal("success"),
    value: Schema.Array(
      Schema.Struct({ titles: Schema.Array(Schema.Struct({ titleId: Schema.String })) }),
    ),
  }),
);

/** Runs the internal function at `path` with the stack's admin key and answers its JSON reply. */
const runInternal = async (path: string, args: Schema.JsonObject) => {
  const response = await fetch(`${url}/api/function`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Convex ${core?.adminKey ?? ""}`,
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });

  return response.text();
};

/** Seeds a library of `names` as movies, each with one file, that `managerId` manages and sees. */
const seedMovies = async (managerId: string, names: ReadonlyArray<string>): Promise<void> => {
  const answer = await runInternal("movies/probe:seed", {
    managerId,
    libraries: [
      { name: `cli-${id}`, titles: names.map((name) => ({ name, age: null, episodes: 0 })) },
    ],
  });

  expect(Seeded(answer).value[0]?.titles).toHaveLength(names.length);
};

const Answered = <A>(value: Schema.Codec<A, unknown>) =>
  parse(Schema.Struct({ status: Schema.Literal("success"), value }));

/** Reports `report` to the core as a new media server, signed in with a key of its own. */
const reportStatus = async (report: ServerReport): Promise<void> => {
  const serviceId = Answered(Schema.String)(
    await runInternal("core/accounts/host:createService", { name: `media server ${id}` }),
  ).value;

  const { key } = Answered(Schema.Struct({ key: Schema.String }))(
    await runInternal("core/auth/apiKeys:issueServiceKey", { serviceId }),
  ).value;

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Platform.layerClient({
            url,
            connection: "http",
            storage: TokenStorage.layerMemory,
            signIn: Platform.SignInRoute.Boundary({
              url: core?.signInUrl ?? "",
              fetch: ownClientFetch(),
            }),
          }),
        );

        const client = Context.get(context, Platform.Client);

        yield* client.session.signIn(Platform.Credentials.ApiKey({ key: Redacted.make(key) }));
        yield* client.run(serverFunctions.reportStatus, [report]);
      }),
    ),
  );
};

const Status = parse(
  Schema.Struct({
    version: Schema.String,
    transcoding: Schema.Struct({
      devices: Schema.Array(Schema.Struct({ domain: Schema.String, node: Schema.String })),
      capabilities: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          status: Schema.String,
          quarantineEndsAt: Schema.Union([Schema.Finite, Schema.String, Schema.Null]),
        }),
      ),
    }),
  }),
);

const Enrolled = parse(Schema.Struct({ deviceId: Schema.String, device: Schema.String }));

const DeviceCode = parse(
  Schema.Struct({ event: Schema.Literal("device_code"), userCode: Schema.String }),
);

const errorCode = (stderr: string): string =>
  parse(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) }))(
    stderr.trimEnd().split("\n").at(-1) ?? "",
  ).error.code;

const setUpOwner = (username: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Platform.layer({
            url,
            connection: "http",
            storage: TokenStorage.layerMemory,
            signIn: Platform.SignInRoute.Boundary({
              url: core?.signInUrl ?? "",
              fetch: ownClientFetch(),
            }),
          }),
        );

        yield* Context.get(context, Platform.Platform).session.signIn(
          Platform.Credentials.Setup({ username, password: Redacted.make(PASSWORD) }),
        );
      }),
    ),
  );

const login = (env: Readonly<Record<string, string>>, username: string, password = PASSWORD) =>
  runCli(["auth", "login", "--server", url, "--username", username], env, password);

let owner: Readonly<Record<string, string>>;

let ownerName = "";

describe.skipIf(core === undefined)("the media CLI against the core", () => {
  beforeAll(async () => {
    buildCli();
    proxy = await startOwnClientProxy(core?.signInUrl ?? "");
    owner = await install();

    const info = await runCli(["auth", "server", "info"], { ...owner, MEDIA_CORE_URL: url });

    if (!Info(info.stdout).hasOwner) await setUpOwner(`owner-${id}`);

    const reset = await runCli(["admin", "reset-password", "--env-file", envFile], owner, PASSWORD);

    expect(reset.code, reset.stderr).toBe(ExitCode.ok);
    ownerName = Reset(reset.stdout).username;
    expect((await login(owner, ownerName)).code).toBe(ExitCode.ok);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(homes.map(removeDir));
    await proxy?.close();
  });

  it("runs movies and core commands on the one session one login saved", async () => {
    const home = await install();

    expect((await login(home, ownerName)).code).toBe(ExitCode.ok);

    const session = await runCli(["auth", "sessions", "current", "--json"], home);

    expect(session.code, session.stderr).toBe(ExitCode.ok);

    const me = parse(Schema.Struct({ userId: Schema.String }))(session.stdout);

    await seedMovies(me.userId, [`Sintel ${id}`, `Pioneer One ${id}`]);

    const titles = await runCli(["movies", "titles", "list", "--limit", "1000"], home);

    expect(titles.code, titles.stderr).toBe(ExitCode.ok);
    expect(Titles(titles.stdout).page.map((title) => title.name)).toEqual(
      expect.arrayContaining([`Sintel ${id}`, `Pioneer One ${id}`]),
    );

    const config = join(home["XDG_CONFIG_HOME"] ?? "", "media", "sessions", "default.json");

    expect(await listTree(join(home["XDG_CONFIG_HOME"] ?? "", "media"))).toEqual([
      "sessions",
      join("sessions", "default.json"),
    ]);
    expect(await permissions(config)).toBe(0o600);
    expect(JSON.parse(await readText(config))).toMatchObject({ url, session: {} });
  });

  it("opens a title in a local player on a stream its ticket negotiated", async () => {
    const home = await install();
    const bin = await makeTempDir("media-core-stack-bin-");
    const played = join(bin, "played");

    homes.push(bin);
    await writeExecutable(join(bin, "mpv"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${played}'\n`);
    expect((await login(home, ownerName)).code).toBe(ExitCode.ok);

    const me = parse(Schema.Struct({ userId: Schema.String }))(
      (await runCli(["auth", "sessions", "current"], home)).stdout,
    );

    await seedMovies(me.userId, [`Big Buck Bunny ${id}`]);

    const negotiated: Array<string> = [];

    const run = await withMediaService(
      (request, response) => {
        let body = "";

        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          negotiated.push(`${request.url ?? ""} ${body}`);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              mode: "direct",
              url: "http://media.local/api/playback/direct/stream?token=t",
              startSeconds: 0,
              durationSeconds: 596,
              video: { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" },
              subtitles: [],
              expiresAt: Date.now() + 3_600_000,
            }),
          );
        });
      },
      (mediaUrl) =>
        runCli(["movies", "stream", `Big Buck Bunny ${id}`, "--open"], {
          ...home,
          MEDIA_SERVER_URL: mediaUrl,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        }),
    );

    expect(run.code, run.stderr).toBe(ExitCode.ok);
    expect(Streamed(run.stdout)).toMatchObject({ title: `Big Buck Bunny ${id}`, mode: "direct" });
    expect(negotiated).toHaveLength(1);
    expect(negotiated[0]).toMatch(/^\/api\/playback\/negotiate \{"token":"[^"]+"/u);
    expect((await readText(played)).split("\n")).toEqual([
      "--start=0",
      `--force-media-title=Big Buck Bunny ${id}`,
      "http://media.local/api/playback/direct/stream?token=t",
      "",
    ]);
  });

  it("prints where a transcoded stream's stages run and why its chain changed", async () => {
    const home = await install();

    expect((await login(home, ownerName)).code).toBe(ExitCode.ok);

    const me = parse(Schema.Struct({ userId: Schema.String }))(
      (await runCli(["auth", "sessions", "current"], home)).stdout,
    );

    await seedMovies(me.userId, [`Sintel ${id}`]);

    const transcode = {
      stages: [
        { op: "decode", domain: "qsv", impl: "decode.qsv" },
        { op: "move", domain: "qsv", impl: "move.qsv>cpu", move: { from: "qsv", to: "cpu" } },
        { op: "tonemap", domain: "cpu", impl: "tonemap.cpu" },
        { op: "move", domain: "qsv", impl: "move.cpu>qsv", move: { from: "cpu", to: "qsv" } },
        { op: "encode", domain: "qsv", impl: "encode.qsv" },
      ],
      changes: [
        {
          at: Date.now(),
          generation: 2,
          cause: "capability",
          excluded: ["tonemap.qsv"],
          reason: "reproduced",
        },
      ],
    };

    const answer = {
      mode: "transcode-qsv",
      url: "http://media.local/media/hls/s/2/index.m3u8?token=t",
      streamId: "stream-0123456789abcde",
      generation: 2,
      startSeconds: 0,
      durationSeconds: 888,
      video: { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" },
      transcode,
      subtitles: [],
      expiresAt: Date.now() + 3_600_000,
    };

    const streamed = (format: ReadonlyArray<string>) =>
      withMediaService(
        (_request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(answer));
        },
        (mediaUrl) =>
          runCli(["movies", "stream", `Sintel ${id}`, ...format], {
            ...home,
            MEDIA_SERVER_URL: mediaUrl,
          }),
      );

    const json = await streamed([]);

    expect(json.code, json.stderr).toBe(ExitCode.ok);
    expect(JSON.parse(json.stdout)).toMatchObject({ mode: "transcode-qsv", transcode });

    const human = await streamed(["--human"]);

    expect(human.code, human.stderr).toBe(ExitCode.ok);
    expect(human.stdout.trimEnd().split("\n")).toEqual([
      `Sintel ${id} (transcode-qsv, from 0:00)`,
      "stages: Decode · QSV, Move · QSV → CPU, Tone map · CPU, Move · CPU → QSV, Encode · QSV",
      "changed: generation 2 · stage failed · off tonemap.qsv · probe failed too",
      answer.url,
    ]);
  });

  it("shows an admin the media server's transcoding report as JSON and as tables", async () => {
    const at = EpochMillis.make(Date.now() - 60_000);
    const version = `0.0.0-${id}`;

    await reportStatus({
      version,
      activeStreams: 1,
      runsAwaitingExit: 0,
      startedAt: at,
      transcoding: {
        build: { version: "9.0.2", kernel: "6.18.63", checkedAt: at },
        devices: [
          {
            domain: "qsv",
            node: "renderD128",
            opened: true,
            pci: "8086:56a5 rev 05",
            kernelDriver: "i915",
            userDriver: "Intel iHD driver 26.3.5",
            checkedAt: at,
          },
        ],
        capabilities: [
          {
            key: "decode.qsv:h264/yuv420p10le",
            domain: "qsv",
            status: "unsupported",
            source: "probe",
            checkedAt: at,
            reason: "refused",
            quarantineEndsAt: null,
          },
          {
            key: "encode.qsv:h264/8/cbr",
            domain: "qsv",
            status: "unknown",
            source: "probe",
            checkedAt: at,
            reason: "passed",
            quarantineEndsAt: "restart",
          },
        ],
      },
    });

    const json = await runCli(["admin", "server", "status"], owner);

    expect(json.code, json.stderr).toBe(ExitCode.ok);
    expect(Status(json.stdout)).toMatchObject({
      version,
      transcoding: {
        devices: [{ domain: "qsv", node: "renderD128" }],
        capabilities: [
          { key: "decode.qsv:h264/yuv420p10le", status: "unsupported", quarantineEndsAt: null },
          { key: "encode.qsv:h264/8/cbr", status: "unknown", quarantineEndsAt: "restart" },
        ],
      },
    });

    const human = await runCli(["admin", "server", "status", "--human"], owner);
    const lines = human.stdout.split("\n");

    expect(human.code, human.stderr).toBe(ExitCode.ok);
    expect(lines).toContain("transcoding:");
    expect(
      lines.some((line) => /^\s+KEY\s+DOMAIN\s+STATUS\s+SOURCE\s+CHECKED AT\s+REASON/u.test(line)),
    ).toBe(true);
    expect(
      lines.some((line) =>
        /decode\.qsv:h264\/yuv420p10le\s+qsv\s+unsupported\s+probe\s+\S+ \S+\s+refused/u.test(line),
      ),
    ).toBe(true);
    expect(lines.some((line) => /encode\.qsv:h264\/8\/cbr .*restart$/u.test(line))).toBe(true);
  });

  it("lists the core's users as its owner", async () => {
    const users = await runCli(["admin", "users", "list", "--limit", "1000"], owner);

    expect(users.code, users.stderr).toBe(ExitCode.ok);
    expect(Users(users.stdout).page).toContainEqual({ username: ownerName, role: "owner" });
  });

  it("refuses media admin to a member with a JSON error", async () => {
    const member = `member-${id}`;

    const created = await runCli(["admin", "users", "create", member], {
      ...owner,
      MEDIA_ARG_PASSWORD: PASSWORD,
    });

    expect(created.code, created.stderr).toBe(ExitCode.ok);

    const home = await install();

    expect((await login(home, member)).code).toBe(ExitCode.ok);

    const refused = await runCli(["admin", "users", "list"], home);

    expect(refused.code).toBe(ExitCode.forbidden);
    expect(errorCode(refused.stderr)).toBe("forbidden");
  });

  it("sets a new password from the host, which ends the old sessions", async () => {
    const person = `lucia-${id}`;

    await runCli(["admin", "users", "create", person], {
      ...owner,
      MEDIA_ARG_PASSWORD: PASSWORD,
    });

    const home = await install();

    expect((await login(home, person)).code).toBe(ExitCode.ok);

    const reset = await runCli(
      ["admin", "reset-password", person, "--env-file", envFile],
      await install(),
      "lucia-new-password",
    );

    expect(reset.code, reset.stderr).toBe(ExitCode.ok);
    expect(Reset(reset.stdout).username).toBe(person);

    const ended = await runCli(["auth", "sessions", "current"], home);

    expect(ended.code).toBe(ExitCode.unauthenticated);
    expect(errorCode(ended.stderr)).toBe("not_logged_in");
    expect(ended.stderr).toContain("media auth login");
    expect((await login(home, person)).code).toBe(ExitCode.unauthenticated);

    const again = await login(home, person, "lucia-new-password");

    expect(again.code, again.stderr).toBe(ExitCode.ok);
    expect(SignedIn(again.stdout).session.username).toBe(person);
  });

  it("signs in with a device code that a signed-in session approves", async () => {
    const device = await install();
    const waiting = startCli(["auth", "login", "--server", url], device);
    const { userCode } = DeviceCode(await waiting.nextErrorLine());

    const approved = await runCli(
      ["auth", "device-codes", "approve", "--user-code", userCode, "--scopes", "account"],
      owner,
    );

    expect(approved.code, approved.stderr).toBe(ExitCode.ok);

    const done = await waiting.done;

    expect(done.code, done.stderr).toBe(ExitCode.ok);

    const session = await runCli(["auth", "sessions", "current"], device);

    expect(Session(session.stdout)).toMatchObject({ username: ownerName, kind: "deviceCode" });
  }, 30_000);

  it("enrolls a new device without a device code, and finds it again by its code", async () => {
    const home = await install();

    expect((await login(home, ownerName)).code).toBe(ExitCode.ok);

    const created = await runCli(["auth", "registry", "enroll", "--name", "laptop"], home);

    expect(created.code, created.stderr).toBe(ExitCode.ok);
    const first = Enrolled(created.stdout);

    const again = await runCli(["auth", "registry", "enroll", "--name", "laptop"], {
      ...home,
      MEDIA_ARG_DEVICE: first.device,
    });

    expect(again.code, again.stderr).toBe(ExitCode.ok);
    expect(Enrolled(again.stdout).deviceId).toBe(first.deviceId);
  });

  it("signs out, and signing out again changes nothing", async () => {
    const home = await install();

    expect((await login(home, ownerName)).code).toBe(ExitCode.ok);
    expect((await runCli(["auth", "logout"], home)).code).toBe(ExitCode.ok);
    expect((await runCli(["auth", "logout"], home)).code).toBe(ExitCode.ok);

    const after = await runCli(["auth", "sessions", "current"], home);

    expect(errorCode(after.stderr)).toBe("not_logged_in");
  });
});

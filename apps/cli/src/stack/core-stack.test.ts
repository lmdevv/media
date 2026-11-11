import { Platform, TokenStorage } from "@media/sdk/effect";
import { ownClientFetch, startOwnClientProxy } from "@media/sdk/testing/own-client";
import type { OwnClientProxy } from "@media/sdk/testing/own-client";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ExitCode } from "../cli-errors";
import { buildCli, makeTempDir, removeDir, runMovies, startMovies } from "../testing/process";
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
  runMovies(["auth", "login", "--server", url, "--username", username], env, password);

let owner: Readonly<Record<string, string>>;

let ownerName = "";

describe.skipIf(core === undefined)("the media CLI against the core", () => {
  beforeAll(async () => {
    buildCli();
    proxy = await startOwnClientProxy(core?.signInUrl ?? "");
    owner = await install();

    const info = await runMovies(["auth", "server", "info"], { ...owner, MEDIA_CORE_URL: url });

    if (!Info(info.stdout).hasOwner) await setUpOwner(`owner-${id}`);

    const reset = await runMovies(
      ["admin", "reset-password", "--env-file", envFile],
      owner,
      PASSWORD,
    );

    expect(reset.code, reset.stderr).toBe(ExitCode.ok);
    ownerName = Reset(reset.stdout).username;
    expect((await login(owner, ownerName)).code).toBe(ExitCode.ok);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(homes.map(removeDir));
    await proxy?.close();
  });

  it("lists the core's users as its owner", async () => {
    const users = await runMovies(["admin", "users", "list", "--limit", "1000"], owner);

    expect(users.code, users.stderr).toBe(ExitCode.ok);
    expect(Users(users.stdout).page).toContainEqual({ username: ownerName, role: "owner" });
  });

  it("refuses media admin to a member with a JSON error", async () => {
    const member = `member-${id}`;

    const created = await runMovies(["admin", "users", "create", member], {
      ...owner,
      MEDIA_ARG_PASSWORD: PASSWORD,
    });

    expect(created.code, created.stderr).toBe(ExitCode.ok);

    const home = await install();

    expect((await login(home, member)).code).toBe(ExitCode.ok);

    const refused = await runMovies(["admin", "users", "list"], home);

    expect(refused.code).toBe(ExitCode.forbidden);
    expect(errorCode(refused.stderr)).toBe("forbidden");
  });

  it("sets a new password from the host, which ends the old sessions", async () => {
    const person = `lucia-${id}`;

    await runMovies(["admin", "users", "create", person], {
      ...owner,
      MEDIA_ARG_PASSWORD: PASSWORD,
    });

    const home = await install();

    expect((await login(home, person)).code).toBe(ExitCode.ok);

    const reset = await runMovies(
      ["admin", "reset-password", person, "--env-file", envFile],
      await install(),
      "lucia-new-password",
    );

    expect(reset.code, reset.stderr).toBe(ExitCode.ok);
    expect(Reset(reset.stdout).username).toBe(person);

    const ended = await runMovies(["auth", "sessions", "current"], home);

    expect(ended.code).toBe(ExitCode.unauthenticated);
    expect(errorCode(ended.stderr)).toBe("not_logged_in");
    expect((await login(home, person)).code).toBe(ExitCode.unauthenticated);

    const again = await login(home, person, "lucia-new-password");

    expect(again.code, again.stderr).toBe(ExitCode.ok);
    expect(SignedIn(again.stdout).session.username).toBe(person);
  });

  it("signs in with a device code that a signed-in session approves", async () => {
    const device = await install();
    const waiting = startMovies(["auth", "login", "--server", url], device);
    const { userCode } = DeviceCode(await waiting.nextErrorLine());

    const approved = await runMovies(
      ["auth", "device-codes", "approve", "--user-code", userCode, "--scopes", "account"],
      owner,
    );

    expect(approved.code, approved.stderr).toBe(ExitCode.ok);

    const done = await waiting.done;

    expect(done.code, done.stderr).toBe(ExitCode.ok);

    const session = await runMovies(["auth", "sessions", "current"], device);

    expect(Session(session.stdout)).toMatchObject({ username: ownerName, kind: "deviceCode" });
  }, 30_000);

  it("enrolls a new device without a device code, and finds it again by its code", async () => {
    const home = await install();

    expect((await login(home, ownerName)).code).toBe(ExitCode.ok);

    const created = await runMovies(["auth", "registry", "enroll", "--name", "laptop"], home);

    expect(created.code, created.stderr).toBe(ExitCode.ok);
    const first = Enrolled(created.stdout);

    const again = await runMovies(["auth", "registry", "enroll", "--name", "laptop"], {
      ...home,
      MEDIA_ARG_DEVICE: first.device,
    });

    expect(again.code, again.stderr).toBe(ExitCode.ok);
    expect(Enrolled(again.stdout).deviceId).toBe(first.deviceId);
  });

  it("signs out, and signing out again changes nothing", async () => {
    const home = await install();

    expect((await login(home, ownerName)).code).toBe(ExitCode.ok);
    expect((await runMovies(["auth", "logout"], home)).code).toBe(ExitCode.ok);
    expect((await runMovies(["auth", "logout"], home)).code).toBe(ExitCode.ok);

    const after = await runMovies(["auth", "sessions", "current"], home);

    expect(errorCode(after.stderr)).toBe("not_logged_in");
  });
});

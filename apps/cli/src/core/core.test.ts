import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import * as FakeConvex from "@media/sdk/testing/fake-convex";
import { jwtExpiringAt, Reply } from "@media/sdk/testing/fake-convex";
import { Effect, Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { groupWords, shortcuts } from "../catalog";
import { ExitCode } from "../cli-errors";
import { writePrivateFile } from "../files";
import { withMediaService } from "../testing/media-service";
import { makeTempDir, readText, removeDir } from "../testing/process";
import { runInProcess, stderrRecords } from "../testing/run-cli";
import { coreGroups } from "../generated/groups";
import { coreEntries, isCoreGroup } from "./routes";

const home = await makeTempDir("media-core-test-");

afterAll(() => removeDir(home));

let homes = 0;

const freshHome = () => {
  homes += 1;
  const dir = join(home, String(homes));

  return { XDG_CONFIG_HOME: dir, HOME: dir };
};

const media = (argv: ReadonlyArray<string>, env: Readonly<Record<string, string>> = freshHome()) =>
  runInProcess(argv, env);

const sessionFile = (env: Readonly<Record<string, string>>, profile = "default"): string =>
  join(env["XDG_CONFIG_HOME"] ?? "", "media", "sessions", `${profile}.json`);

const errorCode = (stderr: string) =>
  Schema.decodeUnknownSync(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) }))(
    stderrRecords(stderr).at(-1),
  ).error.code;

const withFakeCore = <A>(body: (fake: FakeConvex.FakeConvex) => Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(FakeConvex.make, body)));

describe("media's groups", () => {
  it("lists movies, music, admin, and auth first in media --help, then the movies server", async () => {
    const help = await media(["--help"]);

    expect(help.code).toBe(ExitCode.ok);

    const groups = help.stdout.split("\n").flatMap((line) => {
      const [word] = line.trim().split(" ");

      return line.startsWith("  ") && word !== undefined && isCoreGroup(word) ? [word] : [];
    });

    expect(groups).toEqual(["auth", "admin", "movies", "music"]);
    expect(help.stdout).toContain("Usage: media <group> <command> [flags]");
    expect(help.stdout).toContain("Usage: media <command> [flags]");
  });

  it("lists each group's commands, and says when a group has none yet", async () => {
    const admin = await media(["admin", "--help"]);

    expect(admin.code).toBe(ExitCode.ok);
    expect(admin.stdout).toContain("media admin reset-password");
    expect(admin.stdout).toContain("media admin users list");

    const empty = await Promise.all([media(["movies"]), media(["music"])]);

    expect(empty.map((run) => [run.code, run.stdout.includes("None yet")])).toEqual([
      [ExitCode.ok, true],
      [ExitCode.ok, true],
    ]);

    expect((await media(["admin", "users"])).stdout).not.toContain("media admin invites");
  });

  it("answers --help for every command in every group", async () => {
    const runs = await Promise.all(
      coreEntries.map((entry) => media([...entry.command.path.split(" "), "--help"])),
    );

    for (const [index, entry] of coreEntries.entries()) {
      expect(runs[index]?.code, entry.command.path).toBe(ExitCode.ok);
      expect(runs[index]?.stdout, entry.command.path).toContain(
        `Usage: media ${entry.command.path}`,
      );
    }
  });

  it("gives every command its own words, apart from the movies server's", () => {
    const paths = coreEntries.map((entry) => entry.command.path);

    expect(new Set(paths).size).toBe(paths.length);

    const oldWords = new Set([
      ...groupWords,
      ...shortcuts.map((shortcut) => shortcut.path.split(" ")[0] ?? ""),
    ]);

    expect(coreGroups.filter((group) => oldWords.has(group))).toEqual([]);
  });

  it("lists every generated command in media commands with its words and secrets", async () => {
    const listed = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            command: Schema.String,
            secrets: Schema.optionalKey(
              Schema.Array(Schema.Struct({ field: Schema.String, variable: Schema.String })),
            ),
          }),
        ),
      ),
    )((await media(["commands"])).stdout);

    expect(listed.find((entry) => entry.name === "core.accounts.users.create")).toEqual({
      name: "core.accounts.users.create",
      command: "media admin users create",
      secrets: [{ field: "password", variable: "MEDIA_ARG_PASSWORD" }],
    });
  });
});

describe("a core command", () => {
  it("asks for a sign-in when none is stored", async () => {
    const run = await media(["admin", "users", "list"]);

    expect(run.code).toBe(ExitCode.unauthenticated);
    expect(errorCode(run.stderr)).toBe("not_logged_in");
  });

  it("exits as unavailable when the core does not answer", async () => {
    const run = await media(["auth", "server", "info"], {
      ...freshHome(),
      MEDIA_CORE_URL: "http://127.0.0.1:9",
    });

    expect(run.code).toBe(ExitCode.unavailable);
    expect(errorCode(run.stderr)).toBe("unavailable");
  });

  it("never takes a password on the command line", async () => {
    const asFlag = await media(["admin", "users", "create", "bob", "--password", "secret-1"]);

    expect(asFlag.code).toBe(ExitCode.usage);

    const inJson = await media([
      "admin",
      "users",
      "create",
      "--json",
      '{"username":"bob","password":"secret-1"}',
    ]);

    expect(inJson.code).toBe(ExitCode.usage);
    expect(inJson.stderr).toContain("MEDIA_ARG_PASSWORD");
  });

  it("runs as the stored session through the platform SDK", async () => {
    const answer = await withFakeCore((fake) =>
      Effect.gen(function* () {
        yield* fake.reply(
          "core/server:info",
          Reply.Success({ value: { name: "[media]", version: "0.2.0", hasOwner: true } }),
        );

        return yield* Effect.promise(() =>
          media(["auth", "server", "info"], { ...freshHome(), MEDIA_CORE_URL: fake.url }),
        );
      }),
    );

    expect(answer.code).toBe(ExitCode.ok);
    expect(JSON.parse(answer.stdout)).toEqual({
      name: "[media]",
      version: "0.2.0",
      hasOwner: true,
    });
  });

  it("signs out and says so when the core ended the session", async () => {
    const env = freshHome();

    const answer = await withFakeCore((fake) =>
      Effect.gen(function* () {
        const token = jwtExpiringAt(Date.now() + 3_600_000, "user-1|session-1");

        yield* Effect.promise(() =>
          writePrivateFile(
            sessionFile(env),
            JSON.stringify({ url: fake.url, session: { token, refreshToken: "refresh-1" } }),
          ),
        );
        yield* fake.reply(
          "core/auth/sessions:current",
          Reply.Failure({ code: "unauthenticated", message: "This session has ended" }),
        );
        yield* fake.reply("auth:signIn", Reply.Success({ value: { tokens: null } }));

        const run = yield* Effect.promise(() => media(["auth", "sessions", "current"], env));

        return { run, url: fake.url };
      }),
    );

    expect(answer.run.code).toBe(ExitCode.unauthenticated);
    expect(errorCode(answer.run.stderr)).toBe("not_logged_in");
    expect(JSON.parse(await readText(sessionFile(env)))).toEqual({ url: answer.url });
  });
});

const answering =
  (status: number, body: string, seen: Array<string>) =>
  (request: IncomingMessage, response: ServerResponse): void => {
    let text = "";

    request.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    request.on("end", () => {
      seen.push(`${request.headers.authorization ?? ""} ${text}`);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
  };

describe("media admin reset-password", () => {
  const RESET = {
    ...freshHome(),
    MEDIA_CORE_ADMIN_KEY: "admin-key-1",
    MEDIA_ARG_PASSWORD: "new-password",
  };

  it("runs the host function with the admin key and prints whose password it set", async () => {
    const seen: Array<string> = [];

    const run = await withMediaService(
      answering(200, JSON.stringify({ status: "success", value: { username: "lucia" } }), seen),
      (url) => media(["admin", "reset-password", "lucia"], { ...RESET, MEDIA_CORE_URL: url }),
    );

    expect(run.code).toBe(ExitCode.ok);
    expect(JSON.parse(run.stdout)).toEqual({ username: "lucia" });
    expect(seen).toEqual([
      'Convex admin-key-1 {"path":"core/accounts/host:resetPassword","args":{"username":"lucia","password":"new-password"},"format":"json"}',
    ]);
  });

  it("keeps the core's refusal code, and refuses a key the core does not accept", async () => {
    const missing = await withMediaService(
      answering(
        560,
        JSON.stringify({
          status: "error",
          errorMessage: "No user nobody",
          errorData: { code: "not_found", message: "No user nobody" },
        }),
        [],
      ),
      (url) => media(["admin", "reset-password", "nobody"], { ...RESET, MEDIA_CORE_URL: url }),
    );

    expect(missing.code).toBe(ExitCode.notFound);

    const refused = await withMediaService(answering(401, "{}", []), (url) =>
      media(["admin", "reset-password"], { ...RESET, MEDIA_CORE_URL: url }),
    );

    expect(refused.code).toBe(ExitCode.unauthenticated);
  });

  it("asks where the admin key is, never taking the movies backend's from the environment", async () => {
    const run = await media(["admin", "reset-password", "lucia"], {
      ...freshHome(),
      MEDIA_ARG_PASSWORD: "new-password",
      CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "movies-admin-key",
    });

    expect(run.code).toBe(ExitCode.usage);
    expect(run.stderr).toContain("--env-file");
  });
});

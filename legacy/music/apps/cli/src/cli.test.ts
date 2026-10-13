import { createServer } from "node:http";
import { join } from "node:path";

import { commands } from "@music/commands/registry";
import { ConfigProvider, Effect, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./cli";
import { Output } from "./output";
import { makeTempDir, packageRoot, readText, removeDir } from "./testing/process";

/** Runs the CLI in-process with recorded output and only the given environment. */
const invoke = async (argv: ReadonlyArray<string>, env: Readonly<Record<string, string>>) => {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];

  const output = Output.of({
    out: (text) =>
      Effect.sync(() => {
        stdout.push(text);
      }),
    err: (text) =>
      Effect.sync(() => {
        stderr.push(text);
      }),
  });

  const code = await Effect.runPromise(
    runCli(argv).pipe(
      Effect.provideService(Output, output),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    ),
  );

  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
};

const ErrorOutput = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
);

const decodeError = Schema.decodeSync(ErrorOutput);

const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }));

describe("music (in-process)", () => {
  let home = "";

  const run = (...argv: ReadonlyArray<string>) => invoke(argv, { HOME: home });

  beforeAll(async () => {
    home = await makeTempDir("music-cli-unit-");
  });

  afterAll(() => removeDir(home));

  it("prints help for the root, a group, and a command", async () => {
    const root = await run("--help");

    expect(root.code).toBe(0);
    expect(root.stdout).toContain("Usage: music <command> [flags]");
    expect(root.stdout).toContain("playlists create");

    expect((await run()).stdout).toBe(root.stdout);
    expect((await run("playlists")).stdout).toContain("playlists rename");

    const command = await run("playlists", "create", "--help");

    expect(command.code).toBe(0);
    expect(command.stdout).toContain("Usage: music playlists create <name>");
    expect((await run("help", "playlists", "create")).stdout).toBe(command.stdout);
  });

  it("exits 2 with a hint for unknown commands", async () => {
    const result = await run("playlist", "create");

    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      'music: Unknown command "playlist"; did you mean play, playlists?\nRun music --help.',
    );

    const sub = await run("playlists", "make");

    expect(sub.code).toBe(2);
    expect(sub.stderr).toContain("run music playlists --help");
  });

  it("prints usage errors as JSON on stderr with --json", async () => {
    const result = await run("--json", "playback", "volume", "--volume", "loud");

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(decodeError(result.stderr)).toEqual({
      error: { code: "usage", message: '--volume expects a number, got "loud"' },
    });
  });

  it("validates arguments before it needs credentials", async () => {
    const result = await run("libraries", "create", "--name", "x", "--path", "music");

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--path: Expected a string starting with "/"');
  });

  it("exits 3 when no credentials are configured", async () => {
    const result = await run("whoami", "--json");

    expect(result.code).toBe(3);
    expect(decodeError(result.stderr).error.code).toBe("not_logged_in");
  });

  it("requires --server and --key to log in", async () => {
    expect((await run("login", "--server", "https://music.example.com")).code).toBe(2);
    expect((await run("login", "--server", "music.example.com", "--key", "k")).stderr).toContain(
      "--server must be an http(s) URL",
    );
  });

  it("explains a server URL that is not the Convex URL", async () => {
    // The web app's address: its proxy answers Convex API calls with an empty 405.
    const server = createServer((_request, response) => {
      response.writeHead(405).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = decodeAddress(server.address());
    const url = `http://127.0.0.1:${port}`;

    try {
      const result = await run("login", "--server", url, "--key", "mk_test");

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `${url} answered, but not as a [music] server. Use its Convex URL, which ends in /convex`,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("doesn't blame a /convex URL when the server behind it answers with an empty error", async () => {
    // Caddy answers 502 with an empty body while Convex starts or after it crashed.
    const server = createServer((_request, response) => {
      response.writeHead(502).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = decodeAddress(server.address());
    const url = `http://127.0.0.1:${port}/convex`;

    try {
      const result = await run("login", "--server", url, "--key", "mk_test");

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("may still be starting or be down");
      expect(result.stderr).not.toContain("Use its Convex URL");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("lists every registry command with its argument schema", async () => {
    const Catalog = Schema.fromJsonString(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          command: Schema.String,
          kind: Schema.Literals(["query", "mutation"]),
          args: Schema.Struct({ type: Schema.Literal("object") }),
        }),
      ),
    );

    const result = await run("commands", "--json");
    const catalog = Schema.decodeSync(Catalog)(result.stdout);

    expect(catalog.map((entry) => entry.name)).toEqual(Object.keys(commands));
    expect(catalog.find((entry) => entry.name === "playlists.create")?.command).toBe(
      "music playlists create",
    );
  });

  it("keeps the skill's command reference in sync with the registry", async () => {
    const skill = await readText(join(packageRoot, "..", "..", "skills", "music", "SKILL.md"));
    const [, generated = ""] = skill.split("<!-- BEGIN:commands -->");
    const [section = ""] = generated.split("<!-- END:commands -->");
    const reference = await run("commands", "--markdown");

    expect(section.trim(), "run pnpm --filter @music/cli skill:reference").toBe(
      reference.stdout.trim(),
    );
  });

  it("prints its version", async () => {
    expect((await run("--version")).stdout).toMatch(/^\d+\.\d+\.\d+$/u);
  });
});

import { createServer } from "node:http";
import { join } from "node:path";

import { commands } from "@music/commands/registry";
import { ConfigProvider, Effect, Redacted, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./cli";
import { Input } from "./input";
import { Output } from "./output";
import { makeTempDir, packageRoot, readText, removeDir } from "./testing/process";

/** What a script or a person at a terminal supplies on stdin. */
interface Stdin {
  readonly piped?: string;
  /** What the user types at the prompt; the prompt is only offered when this is set. */
  readonly typed?: string;
}

/** Stdin as a pipe or a terminal, recording each prompt shown. */
const stdinOf = (stdin: Stdin, prompts: Array<string>) =>
  Input.of({
    interactive: Effect.succeed(stdin.typed !== undefined),
    readAll: Effect.succeed(Redacted.make(stdin.piped ?? "")),
    promptSecret: (question) =>
      Effect.sync(() => {
        prompts.push(question);

        return Redacted.make(stdin.typed ?? "");
      }),
  });

/** Runs the CLI in-process with recorded output and only the given environment. */
const invoke = async (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  stdin: Stdin = {},
) => {
  const prompts: Array<string> = [];
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
      Effect.provideService(Input, stdinOf(stdin, prompts)),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    ),
  );

  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), prompts };
};

const ErrorOutput = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
);

const decodeError = Schema.decodeSync(ErrorOutput);

const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }));

/** A stand-in server that records each request body and answers like a Convex that is down. */
interface Recording {
  readonly url: string;
  readonly bodies: Array<string>;
  readonly close: () => Promise<void>;
}

const recordingServer = async (host: string): Promise<Recording> => {
  const bodies: Array<string> = [];

  const server = createServer((request, response) => {
    let body = "";

    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      bodies.push(body);
      response.writeHead(502).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, host, resolve));

  const { port } = decodeAddress(server.address());

  return {
    url: `http://${host}:${port}`,
    bodies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

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

  it("requires --server and a key to log in", async () => {
    expect((await run("login", "--key", "k")).stderr).toContain("login needs --server <url>");
    expect((await run("login", "--server", "music.example.com", "--key", "k")).stderr).toContain(
      "--server must be an http(s) URL",
    );

    const keyless = await run("login", "--server", "https://music.example.com/convex");

    expect(keyless.code).toBe(2);
    expect(keyless.stderr).toContain("pipe it to --key-stdin, or set MUSIC_API_KEY");
  });

  describe("login key sources", () => {
    let server: Recording = { url: "", bodies: [], close: () => Promise.resolve() };

    beforeAll(async () => {
      server = await recordingServer("127.0.0.1");
    });

    afterAll(() => server.close());

    const signedInWith = (key: string): boolean =>
      server.bodies.some((body) => body.includes(`"key":"${key}"`));

    it("reads the key from stdin with --key-stdin, without a trailing newline", async () => {
      const result = await invoke(
        ["login", "--server", `${server.url}/convex`, "--key-stdin"],
        { HOME: home },
        { piped: "mk_piped-key\n" },
      );

      expect(result.code).toBe(1);
      expect(signedInWith("mk_piped-key")).toBe(true);
    });

    it("refuses an empty --key-stdin and --key with --key-stdin", async () => {
      const empty = await invoke(
        ["login", "--server", `${server.url}/convex`, "--key-stdin"],
        { HOME: home },
        { piped: "\n" },
      );

      expect(empty.code).toBe(2);
      expect(empty.stderr).toContain("--key-stdin read no key from stdin");

      const both = await run(
        "login",
        "--server",
        `${server.url}/convex`,
        "--key",
        "k",
        "--key-stdin",
      );

      expect(both.code).toBe(2);
      expect(both.stderr).toContain("Use --key or --key-stdin, not both");

      const blank = await run("login", "--server", `${server.url}/convex`, "--key", " ");

      expect(blank.code).toBe(2);
      expect(blank.stderr).toContain("--key is empty");
    });

    it("takes the key from MUSIC_API_KEY", async () => {
      const result = await invoke(["login", "--server", `${server.url}/convex`], {
        HOME: home,
        MUSIC_API_KEY: "mk_env-key",
      });

      expect(result.code).toBe(1);
      expect(signedInWith("mk_env-key")).toBe(true);
    });

    it("asks with the hidden prompt when --key-stdin is given a terminal", async () => {
      const result = await invoke(
        ["login", "--server", `${server.url}/convex`, "--key-stdin"],
        { HOME: home },
        { typed: "mk_typed-for-stdin", piped: "mk_never-read" },
      );

      expect(result.prompts).toEqual(["API key: "]);
      expect(signedInWith("mk_typed-for-stdin")).toBe(true);
      expect(signedInWith("mk_never-read")).toBe(false);
    });

    it("asks for the key at a terminal", async () => {
      const result = await invoke(
        ["login", "--server", `${server.url}/convex`],
        { HOME: home },
        { typed: "mk_typed-key" },
      );

      expect(result.prompts).toEqual(["API key: "]);
      expect(signedInWith("mk_typed-key")).toBe(true);
    });
  });

  describe("plain http to another machine", () => {
    // 0.0.0.0 reaches this machine without being a loopback name, so it stands in for a remote
    // server while the request still lands on the recording server.
    let server: Recording = { url: "", bodies: [], close: () => Promise.resolve() };

    beforeAll(async () => {
      server = await recordingServer("0.0.0.0");
    });

    afterAll(() => server.close());

    it("refuses to log in without --insecure, before asking for the key", async () => {
      const refused = await invoke(
        ["login", "--server", `${server.url}/convex`],
        { HOME: home },
        { typed: "mk_never-sent" },
      );

      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("would send the API key unencrypted");
      expect(refused.stderr).toContain("--insecure");
      expect(refused.prompts).toEqual([]);
      expect(server.bodies).toEqual([]);

      const allowed = await run(
        "login",
        "--server",
        `${server.url}/convex`,
        "--key",
        "mk_insecure",
        "--insecure",
      );

      expect(allowed.code).toBe(1);
      expect(server.bodies.some((body) => body.includes('"key":"mk_insecure"'))).toBe(true);
    });

    it("refuses MUSIC_SERVER unless MUSIC_INSECURE is set", async () => {
      const env = {
        HOME: home,
        MUSIC_SERVER: `${server.url}/convex`,
        MUSIC_API_KEY: "mk_env-remote",
      };

      const refused = await invoke(["whoami"], env);

      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("MUSIC_INSECURE=1");

      // An empty or unrecognized value leaves it off rather than breaking every command.
      const offs = await Promise.all(
        ["", "nope"].map((off) => invoke(["whoami"], { ...env, MUSIC_INSECURE: off })),
      );

      for (const result of offs) {
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("MUSIC_INSECURE=1");
      }

      expect((await invoke(["whoami"], { HOME: home, MUSIC_INSECURE: "" })).code).toBe(3);

      const allowed = await invoke(["whoami"], { ...env, MUSIC_INSECURE: "yes" });

      expect(allowed.code).toBe(1);
      expect(server.bodies.some((body) => body.includes('"key":"mk_env-remote"'))).toBe(true);
    });
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

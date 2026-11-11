import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jwtExpiringAt } from "@media/sdk/testing/fake-convex";
import { afterAll, describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

import { ExitCode } from "./cli-errors";
import { coreEntries } from "./core/routes";
import { generatedCommands } from "./generated/commands";
import { withMediaService } from "./testing/media-service";
import type { CliRun } from "./testing/run-cli";
import { runInProcess, stderrRecords } from "./testing/run-cli";

const home = mkdtempSync(join(tmpdir(), "media-cli-test-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const env = { XDG_CONFIG_HOME: home, HOME: home };

const media = (...argv: ReadonlyArray<string>) => runInProcess(argv, env);

/** A home whose `home` profile holds a session for the core at `url`, as `media auth login` saves it. */
const storedHome = (url: string) => {
  const dir = mkdtempSync(join(tmpdir(), "media-stored-home-"));
  const path = join(dir, "media", "sessions", "home.json");

  const stored = `${JSON.stringify({
    url,
    session: {
      token: jwtExpiringAt(Date.now() + 3_600_000, "user-1|session-1"),
      refreshToken: "refresh-home",
    },
  })}\n`;

  mkdirSync(join(dir, "media", "sessions"), { recursive: true });
  writeFileSync(path, stored);

  return { home: dir, path, stored };
};

/** The old movies server's top-level words, which `media movies` and the core replace. */
const OLD_WORDS = [
  "login",
  "logout",
  "whoami",
  "profiles",
  "keys",
  "search",
  "play",
  "progress",
  "continue",
  "rooms",
  "scan",
  "import",
  "backup",
  "restore",
  "titles",
  "libraries",
  "jobs",
  "metadata",
];

describe("the media command", () => {
  it("prints help and the version", async () => {
    const help = await media("--help");

    expect(help.code).toBe(ExitCode.ok);
    expect(help.stdout).toContain("Usage: media <group> <command> [flags]");
    expect((await media("--version")).stdout).toBe(packageJson.version);
  });

  it("lists the groups and none of the old movies server's words", async () => {
    const help = (await media("--help")).stdout;

    for (const group of ["auth", "admin", "movies", "music"]) {
      expect(help).toMatch(new RegExp(`^  ${group} `, "mu"));
    }

    for (const old of OLD_WORDS) {
      expect(help, old).not.toMatch(new RegExp(`^  media ${old}\\b`, "mu"));
      expect(help, old).not.toMatch(new RegExp(`^  ${old} `, "mu"));
    }
  });

  it("answers --help for every command and the troubleshooting ones", async () => {
    const runs = await Promise.all([
      ...coreEntries.map((entry) => media(...entry.command.path.split(" "), "--help")),
      media("logs", "--help"),
      media("diagnostics", "playback", "--help"),
      media("diagnostics", "sessions", "--help"),
      media("diagnostics"),
    ]);

    for (const run of runs) {
      expect(run.code, run.stderr).toBe(ExitCode.ok);
      expect(run.stdout).toContain("Usage: media");
    }
  });

  it("names where an old movies word moved, as a usage error", async () => {
    const cases = {
      "titles list": "media movies titles list",
      "my-list add": "media movies my-list add",
      "api-keys create": "media auth api-keys create",
      "play Sintel": "media movies stream",
      login: "media auth login",
      whoami: "media auth sessions current",
      continue: "media movies history continue-watching",
    };

    const runs = await Promise.all(
      Object.entries(cases).map(async ([typed, moved]) => ({
        typed,
        moved,
        run: await media(...typed.split(" ")),
      })),
    );

    for (const { typed, moved, run } of runs) {
      expect(run.code, typed).toBe(ExitCode.usage);
      expect(JSON.parse(run.stderr), typed).toMatchObject({ error: { code: "usage" } });
      expect(JSON.parse(run.stderr), typed).toMatchObject({
        error: { message: `Unknown command "${typed}"; it moved: run ${moved}` },
      });
    }
  });

  it("reports other unknown commands as usage errors with suggestions", async () => {
    const [close, flag, typo] = await Promise.all([
      media("mov"),
      media("--json"),
      media("diagnostics", "sesions"),
    ]);

    expect(close.code).toBe(ExitCode.usage);
    expect(close.stderr).toContain("did you mean movies");
    expect(JSON.parse(flag.stderr)).toStrictEqual({
      error: { code: "usage", message: 'Unknown command "--json"' },
    });
    expect(typo.code).toBe(ExitCode.usage);
    expect(typo.stderr).toContain('Unknown command \\"diagnostics sesions\\"');
  });

  it("accepts camelCase words", async () => {
    const run = await media("movies", "myList", "add", "--help");

    expect(run.code, run.stderr).toBe(ExitCode.ok);
    expect(run.stdout).toContain("Command movies.myList.add");
  });

  it("refuses a blank --version or a wild --max-height offline", async () => {
    const runs = await Promise.all([
      media("movies", "stream", "Alien", "--version", ""),
      media("movies", "stream", "Alien", "--version", "   "),
      media("movies", "stream", "Alien", "--max-height", "9000"),
      media("movies", "stream"),
    ]);

    const [blank, , height, missing] = runs;

    for (const run of runs) expect(run.code, run.stderr).toBe(ExitCode.usage);
    expect(blank.stderr).toContain("--version expects a version name or its number");
    expect(height.stderr).toContain("--max-height expects lines");
    expect(missing.stderr).toContain("needs a title name or ID");
  });

  it("asks to sign in with media auth login before calling the server", async () => {
    const runs = await Promise.all([
      media("movies", "titles", "list"),
      media("movies", "stream", "Alien"),
      media("logs"),
    ]);

    for (const run of runs) {
      expect(run.code).toBe(ExitCode.unauthenticated);
      expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: "not_logged_in" } });
      expect(run.stderr).toContain("media auth login");
    }
  });

  it("takes a bare --json as JSON output, and --json with an object as the arguments", async () => {
    const [bare, beforeFlag, withHuman, args] = await Promise.all([
      media("movies", "titles", "list", "--json"),
      media("movies", "titles", "list", "--json", "--limit", "5"),
      media("movies", "titles", "list", "--json", "--human"),
      media("movies", "titles", "search", "--json", '{"query":"alien"}'),
    ]);

    for (const run of [bare, beforeFlag, args]) {
      expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: "not_logged_in" } });
    }

    expect(withHuman.code).toBe(ExitCode.usage);
  });

  it("prints human errors with --human", async () => {
    const run = await media("movies", "titles", "list", "--human");

    expect(run.stderr.startsWith("media: Not signed in")).toBe(true);
  });

  it("rejects an unreadable profile file with a config error", async () => {
    const bad = mkdtempSync(join(tmpdir(), "media-bad-config-"));

    mkdirSync(join(bad, "media", "sessions"), { recursive: true });
    writeFileSync(join(bad, "media", "sessions", "default.json"), "{not json");
    const run = await runInProcess(["movies", "titles", "list"], { XDG_CONFIG_HOME: bad });

    rmSync(bad, { recursive: true, force: true });
    expect(run.code).toBe(ExitCode.failed);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: "config_error" } });
  });

  it("reads the profile from --profile, then MEDIA_PROFILE, then default", async () => {
    const { home: stored, path } = storedHome("http://127.0.0.1:9");
    const before = readFileSync(path, "utf8");

    const runs = await Promise.all([
      runInProcess(["auth", "logout", "--profile", "home"], { XDG_CONFIG_HOME: stored }),
      runInProcess(["auth", "logout"], { XDG_CONFIG_HOME: stored, MEDIA_PROFILE: "other" }),
      runInProcess(["auth", "logout"], { XDG_CONFIG_HOME: stored }),
    ]);

    const after = readFileSync(path, "utf8");

    rmSync(stored, { recursive: true, force: true });
    const [flag, fromEnv, fallback] = runs;

    expect(JSON.parse(flag.stdout)).toMatchObject({ profile: "home", signedOut: true });
    expect(JSON.parse(fromEnv.stdout)).toMatchObject({ profile: "other", signedOut: false });
    expect(JSON.parse(fallback.stdout)).toMatchObject({ profile: "default", signedOut: false });
    expect(JSON.parse(before)).toHaveProperty("session");
    expect(JSON.parse(after)).toStrictEqual({ url: "http://127.0.0.1:9" });
  });

  it("lists every command as JSON with argument schemas", async () => {
    const run = await media("commands");

    for (const command of generatedCommands) {
      expect(run.stdout).toContain(`"name": "${command.name}"`);
    }

    expect(run.stdout).toContain('"command": "media movies stream"');
  });
});

const withSignedInMedia = (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (signedIn: (...argv: ReadonlyArray<string>) => Promise<CliRun>) => Promise<void>,
) =>
  withMediaService(handler, async (mediaUrl) => {
    const { home: signedIn } = storedHome("http://127.0.0.1:9");

    try {
      await run((...argv) =>
        runInProcess(argv, {
          XDG_CONFIG_HOME: signedIn,
          MEDIA_PROFILE: "home",
          MEDIA_SERVER_URL: mediaUrl,
        }),
      );
    } finally {
      rmSync(signedIn, { recursive: true, force: true });
    }
  });

const hostile = "a\u001b[2Jb\u007fc\u0085d\u009be\u202ef\u2028g\u2066h\u200fi";

const REQUEST_ID = "4fad7a5c-9b6e-4c3d-8ebf-7a8b9cadbec5";

const hostileRecord = `${JSON.stringify({
  message: `Player.error ${hostile}`,
  level: "WARN",
  timestamp: "2026-10-21T20:01:02.123Z",
  annotations: { detail: hostile, [`key${hostile}`]: 1 },
  spans: {},
})}\n`;

const timeline = {
  sessionId: `session${hostile}`,
  firstSeenAt: Date.UTC(2026, 9, 21, 20),
  lastSeenAt: Date.UTC(2026, 9, 21, 20, 47),
  platform: "web",
  counts: {
    streams: 1,
    stalls: 0,
    stalledMs: 0,
    slowSegments: 0,
    failedRequests: 0,
    playerErrors: 1,
    recoveries: 0,
    slowFragments: 0,
    droppedFrames: 0,
  },
  drift: { status: "not-measured", reason: `No report ${hostile}` },
  missing: [`Gap ${hostile}`],
  truncated: false,
  entries: [
    {
      at: Date.UTC(2026, 9, 21, 20, 1),
      source: "player",
      kind: "player-error",
      level: "WARN",
      streamId: null,
      summary: `Player said ${hostile}`,
      details: { detail: hostile },
    },
  ],
};

const sessionList = [
  {
    sessionId: `session${hostile}`,
    userId: null,
    firstSeenAt: Date.UTC(2026, 9, 21, 20),
    lastSeenAt: Date.UTC(2026, 9, 21, 20, 47),
    platform: "web",
    warnings: 1,
  },
];

const diagnosticsService = (request: IncomingMessage, response: ServerResponse) => {
  const body = { "/api/diagnostics/playback": timeline, "/api/diagnostics/sessions": sessionList };

  if (request.url === "/api/logs") {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(hostileRecord);
  } else if (
    request.url === "/api/diagnostics/playback" ||
    request.url === "/api/diagnostics/sessions"
  ) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body[request.url]));
  } else {
    response.writeHead(404).end();
  }
};

const hasControl = (text: string): boolean =>
  /[\p{Cc}\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(text.replaceAll("\n", ""));

describe("troubleshooting commands", () => {
  it("refuses flags they cannot read before connecting", async () => {
    const since = await media("logs", "--since", "whenever");
    const follow = await media("logs", "--follow", "--until", "1h");
    const level = await media("logs", "--level", "loud");

    expect(since.code).toBe(ExitCode.usage);
    expect(since.stderr).toContain("--since expects a duration");
    expect(follow.stderr).toContain("drop --until");
    expect(level.stderr).toContain("--level must be");
  });

  it("refuses a window that ends before or when it starts, before connecting", async () => {
    const runs = await Promise.all([
      media("logs", "--since", "1m", "--until", "2m"),
      media("logs", "--since", "2026-10-21T14:00:00Z", "--until", "2026-10-21T14:00:00Z"),
    ]);

    for (const run of runs) {
      expect(run.code).toBe(ExitCode.usage);
      expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: "usage" } });
    }
  });

  it("prints no control character a player sent, in logs or a playback timeline", async () => {
    await withSignedInMedia(diagnosticsService, async (signedIn) => {
      const logs = await signedIn("logs");
      const playback = await signedIn("diagnostics", "playback", "s1", "--human");
      const sessions = await signedIn("diagnostics", "sessions", "--human");

      for (const [name, run] of Object.entries({ logs, playback, sessions })) {
        expect(run.code, `${name}: ${run.stderr}`).toBe(ExitCode.ok);
        expect(hasControl(run.stdout), name).toBe(false);
        expect(run.stdout, name).toContain(
          String.raw`a\u001b[2Jb\u007fc\u0085d\u009be\u202ef\u2028g\u2066h\u200fi`,
        );
      }

      expect(logs.stdout).toContain(
        String.raw`detail="a\u001b[2Jb\u007fc\u0085d\u009be\u202ef\u2028g\u2066h\u200fi"`,
      );
    });
  });

  it("takes --json and --human the same way in logs and diagnostics", async () => {
    await withSignedInMedia(diagnosticsService, async (signedIn) => {
      const logs = await signedIn("logs", "--json");
      const playback = await signedIn("diagnostics", "playback", "s1", "--json");
      const sessions = await signedIn("diagnostics", "sessions", "--json");

      expect(logs.stdout).toBe(hostileRecord.trim());
      expect(JSON.parse(playback.stdout)).toMatchObject({ sessionId: timeline.sessionId });
      expect(JSON.parse(sessions.stdout)).toMatchObject([{ warnings: 1 }]);

      const both = await Promise.all([
        signedIn("logs", "--json", "--human"),
        signedIn("diagnostics", "playback", "s1", "--json", "--human"),
        signedIn("diagnostics", "sessions", "--json", "--human"),
      ]);

      for (const run of both) expect(run.code, run.stderr).toBe(ExitCode.usage);
    });
  });

  it("says when the service cannot keep its log, instead of printing nothing", async () => {
    await withSignedInMedia(
      (_request, response) => {
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "x-movies-log-unavailable-since": "2026-10-21T20:00:00.000Z",
        });
        response.end();
      },
      async (signedIn) => {
        const runs = await Promise.all([signedIn("logs"), signedIn("logs", "--json")]);

        for (const run of runs) {
          expect(run.code, run.stderr).toBe(ExitCode.ok);
          expect(run.stdout).toBe("");
          expect(run.stderr).toContain(
            "The media service has not been able to write or read its retained log since",
          );
        }
      },
    );
  });

  it("fails as unavailable when the service ends a followed log", async () => {
    const ending = {
      "closes the response": (response: ServerResponse) => response.end(),
      "drops the connection": (response: ServerResponse) => response.socket?.destroy(),
    };

    await Promise.all(
      Object.entries(ending).map(([how, end]) =>
        withSignedInMedia(
          (_request, response) => {
            response.writeHead(200, { "content-type": "application/x-ndjson" });
            response.write(hostileRecord, () => setTimeout(() => end(response), 50));
          },
          async (signedIn) => {
            const run = await signedIn("logs", "--follow");

            expect(run.code, how).toBe(ExitCode.unavailable);
            expect(JSON.parse(run.stderr), how).toMatchObject({ error: { code: "unavailable" } });
            expect(run.stdout, how).toContain("Player.error");
          },
        ),
      ),
    );
  });

  it("prints the request ID of a failed media service answer, to find its log lines", async () => {
    await withSignedInMedia(
      (request, response) => {
        const refused = request.url === "/api/logs";

        response.writeHead(refused ? 403 : 500, {
          "content-type": "application/json",
          "x-request-id": REQUEST_ID,
        });
        response.end(
          refused
            ? JSON.stringify({ code: "forbidden", message: "Admins only" })
            : "<html>Internal error</html>",
        );
      },
      async (signedIn) => {
        const refused = await signedIn("logs");
        const garbled = await signedIn("diagnostics", "sessions");
        const human = await signedIn("logs", "--human");

        expect(refused.code).toBe(ExitCode.forbidden);
        expect(JSON.parse(refused.stderr)).toStrictEqual({
          error: { code: "forbidden", message: "Admins only", requestId: REQUEST_ID },
        });
        expect(JSON.parse(garbled.stderr)).toMatchObject({
          error: { code: "protocol_error", requestId: REQUEST_ID },
        });
        expect(human.stderr.split("\n")).toStrictEqual([
          "media: Admins only",
          `Request ID: ${REQUEST_ID}`,
        ]);
      },
    );
  });

  it("prints debug logs on stderr only with --verbose, as NDJSON unless --human", async () => {
    await withSignedInMedia(
      (_request, response) => {
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "x-request-id": REQUEST_ID,
        });
        response.end(hostileRecord);
      },
      async (signedIn) => {
        const quiet = await signedIn("logs", "--json");
        const negated = await signedIn("--verbose", "logs", "--json", "--no-verbose");
        const verbose = await signedIn("--verbose", "logs", "--json");
        const trailing = await signedIn("logs", "--json", "--verbose");
        const human = await signedIn("logs", "--human", "--verbose");

        expect(quiet.stderr).toBe("");
        expect(negated.stderr).toBe("");

        for (const run of [verbose, trailing]) {
          expect(run.code, run.stderr).toBe(ExitCode.ok);
          expect(run.stdout).toBe(hostileRecord.trim());
          expect(stderrRecords(run.stderr)).toMatchObject([
            {
              message: "MediaHttp.response",
              level: "DEBUG",
              annotations: { operation: "logs", status: 200, requestId: REQUEST_ID },
            },
          ]);
        }

        expect(human.stderr).toMatch(
          new RegExp(
            `DEBUG MediaHttp\\.response operation=logs status=200 requestId=${REQUEST_ID}`,
            "u",
          ),
        );
      },
    );
  });

  it("asks the service for measured drift and prints it", async () => {
    await withSignedInMedia(
      (request, response) => {
        let body = "";

        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          const measured = body.includes('"measuredDrift":true');

          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              ...timeline,
              drift: measured
                ? {
                    status: "measured",
                    method: "video-frame-vs-media-clock",
                    samples: 54,
                    medianMs: -12,
                    worstMs: -41,
                  }
                : { status: "not-measured", reason: "This client predates measured drift." },
            }),
          );
        });
      },
      async (signedIn) => {
        const run = await signedIn("diagnostics", "playback", "s1", "--human");

        expect(run.code, run.stderr).toBe(ExitCode.ok);
        expect(run.stdout).toContain("Audio/video drift: median -12 ms, worst -41 ms over 54");
      },
    );
  });

  it("asks for a session ID and says where to find one", async () => {
    const run = await media("diagnostics", "playback");

    expect(run.code).toBe(ExitCode.usage);
    expect(run.stderr).toContain("media diagnostics sessions");
  });
});

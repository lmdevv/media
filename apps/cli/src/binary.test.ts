import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

import type { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ExitCode } from "./cli-errors";
import { withMediaService } from "./testing/media-service";
import { buildCli, makeTempDir, removeDir, runMovies, startMovies } from "./testing/process";
import { stderrRecords } from "./testing/run-cli";

let home = "";

beforeAll(async () => {
  buildCli();
  home = await makeTempDir("media-cli-binary-");
}, 60_000);

afterAll(() => removeDir(home));

const jwtExpiringAt = (epochSeconds: number): string =>
  [{ alg: "none" }, { exp: epochSeconds, sub: "user" }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("fake")
    .join(".");

const convexAnswer = (response: ServerResponse, value: Schema.Json): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "success", value, logLines: [] }));
};

const convexRefusal = (response: ServerResponse): void => {
  const failure = { code: "expired", message: "Device code expired" };

  response.writeHead(560, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      status: "error",
      errorMessage: failure.message,
      errorData: failure,
      logLines: [],
    }),
  );
};

const RENEWED = jwtExpiringAt(4_102_444_800);

const sessionFile = (dir: string): string => join(dir, "media", "sessions", "default.json");

const writeProfile = (dir: string, profile: Schema.Json): void => {
  mkdirSync(join(dir, "media", "sessions"), { recursive: true });
  writeFileSync(sessionFile(dir), JSON.stringify(profile));
};

const afterFailedSave = (
  name: string,
  answer: (response: ServerResponse) => void,
  flags: ReadonlyArray<string> = [],
) => {
  const signedIn = join(home, name);

  return withMediaService(
    (request, response) => {
      request.resume().on("end", () => {
        if (request.url === "/api/action") {
          // A directory in the file's place: saving the renewed session fails.
          rmSync(sessionFile(signedIn));
          mkdirSync(sessionFile(signedIn));
          convexAnswer(response, { tokens: { token: RENEWED, refreshToken: "refresh-renewed" } });
        } else answer(response);
      });
    },
    (url) => {
      writeProfile(signedIn, {
        url,
        session: { token: jwtExpiringAt(1_000_000_000), refreshToken: "refresh-home" },
      });

      return runMovies(["auth", "sessions", "current", ...flags], {
        XDG_CONFIG_HOME: signedIn,
        HOME: signedIn,
      });
    },
  );
};

const SESSION = {
  userId: "users:1",
  username: "ana",
  displayName: null,
  role: "owner",
  sessionId: "authSessions:1",
  kind: "password",
  scopes: ["account"],
  device: null,
};

describe("the media binary", () => {
  it("rejects an empty secret on stdin before connecting", async () => {
    const env = { XDG_CONFIG_HOME: home, HOME: home };

    const runs = await Promise.all([
      runMovies(
        ["admin", "reset-password", "ana"],
        { ...env, MEDIA_CORE_URL: "http://127.0.0.1:9", MEDIA_CORE_ADMIN_KEY: "admin-key" },
        " \n",
      ),
      runMovies(
        ["auth", "login", "--server", "http://127.0.0.1:9", "--username", "ana"],
        env,
        " \n",
      ),
    ]);

    for (const run of runs) {
      expect(run.code, run.stderr).toBe(ExitCode.usage);
      expect(run.stderr).toContain("on stdin is empty");
    }
  });

  it(
    "runs a command whose only secret is optional without waiting on an open stdin",
    { timeout: 20_000 },
    async () => {
      const signedIn = join(home, "open-stdin");
      const enrolled = { deviceId: "devices:1", device: "dv_1.secret", joinSequence: 1 };

      mkdirSync(join(signedIn, "media", "sessions"), { recursive: true });

      const run = await withMediaService(
        (request, response) => {
          request.resume().on("end", () => {
            convexAnswer(response, enrolled);
          });
        },
        async (url) => {
          writeFileSync(
            join(signedIn, "media", "sessions", "default.json"),
            JSON.stringify({
              url,
              session: { token: RENEWED, refreshToken: "refresh-1" },
            }),
          );

          const running = startMovies(
            ["auth", "registry", "enroll", "--name", "Laptop"],
            { XDG_CONFIG_HOME: signedIn, HOME: signedIn, MEDIA_CORE_URL: url },
            null,
          );

          const timedOut = setTimeout(() => running.child.kill(), 10_000);

          try {
            return await running.done;
          } finally {
            clearTimeout(timedOut);
          }
        },
      );

      expect(run.code, run.stderr).toBe(ExitCode.ok);
      expect(JSON.parse(run.stdout)).toStrictEqual(enrolled);
    },
  );

  it("rejects a secret variable that is set but empty, without reading stdin", async () => {
    const env = { XDG_CONFIG_HOME: home, HOME: home };

    const runs = await Promise.all([
      runMovies(
        ["admin", "reset-password", "ana"],
        {
          ...env,
          MEDIA_CORE_URL: "http://127.0.0.1:9",
          MEDIA_CORE_ADMIN_KEY: "admin-key",
          MEDIA_ARG_PASSWORD: "",
        },
        "password\n",
      ),
      runMovies(
        ["auth", "login", "--server", "http://127.0.0.1:9", "--username", "ana"],
        { ...env, MEDIA_PASSWORD: " " },
        "password\n",
      ),
    ]);

    for (const run of runs) {
      expect(run.code, run.stderr).toBe(ExitCode.usage);
      expect(run.stderr).toContain("is set but empty");
    }
  });

  it("ends quietly when the reader of its output stops early, as `media logs | head` does", async () => {
    const signedIn = join(home, "signed-in");

    const record = `${JSON.stringify({
      message: "Stream.started",
      level: "INFO",
      timestamp: "2026-10-21T20:01:02.123Z",
      annotations: {},
    })}\n`;

    writeProfile(signedIn, {
      url: "http://127.0.0.1:9",
      session: { token: RENEWED, refreshToken: "refresh-home" },
    });

    const run = await withMediaService(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(record.repeat(5000));
      },
      (mediaUrl) => {
        const running = startMovies(["logs", "--json", "--limit", "5000"], {
          XDG_CONFIG_HOME: signedIn,
          HOME: signedIn,
          MEDIA_SERVER_URL: mediaUrl,
        });

        running.child.stdout.once("data", () => running.child.stdout.destroy());

        return running.done;
      },
    );

    expect(run.stderr).not.toContain("EPIPE");
    expect(run.code, run.stderr).toBe(ExitCode.ok);
  });

  it("keeps stdout pure JSON when the SDK warns, printing the warning on stderr as NDJSON", async () => {
    const run = await afterFailedSave("warns", (response) => convexAnswer(response, SESSION));

    expect(run.code, run.stderr).toBe(ExitCode.ok);
    expect(JSON.parse(run.stdout)).toStrictEqual(SESSION);
    expect(stderrRecords(run.stderr)).toMatchObject([
      { level: "WARN", message: "Auth.tokenStorageFailed", annotations: { operation: "save" } },
    ]);
    expect(run.stderr).not.toContain(RENEWED);
    expect(run.stderr).not.toContain("refresh-renewed");
  });

  it("keeps stderr NDJSON when the SDK warns before the command fails", async () => {
    const run = await afterFailedSave("warns-then-fails", convexRefusal);

    expect(run.code, run.stderr).toBe(ExitCode.expired);
    expect(run.stdout).toBe("");
    expect(stderrRecords(run.stderr)).toMatchObject([
      { level: "WARN", message: "Auth.tokenStorageFailed" },
      { error: { code: "expired", message: "Device code expired" } },
    ]);
  });

  it("prints the warning and the failure as text with --human", async () => {
    const run = await afterFailedSave("warns-for-people", convexRefusal, ["--human"]);

    expect(run.code, run.stderr).toBe(ExitCode.expired);
    expect(run.stderr).toMatch(/WARN\s+Auth\.tokenStorageFailed operation=save/u);
    expect(run.stderr).toContain("media: Device code expired");
  });
});

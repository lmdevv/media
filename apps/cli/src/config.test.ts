import type { ServerResponse } from "node:http";
import { join } from "node:path";

import { MediaRoutes } from "@media/sdk/effect";
import { jwtExpiringAt } from "@media/sdk/testing/fake-convex";
import { Cause, ConfigProvider, Effect, Exit, Option, Predicate, Redacted } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { connect, resolveTarget, retarget } from "./config";
import { writePrivateFile } from "./files";
import { withMediaService } from "./testing/media-service";
import { makeTempDir, removeDir } from "./testing/process";

const home = await makeTempDir("media-config-test-");

afterAll(() => removeDir(home));

let homes = 0;

/** A profile file as `media auth login` writes it. */
interface StoredFile {
  readonly url: string;
  readonly mediaUrl?: string;
  readonly session?: { readonly token: string; readonly refreshToken: string };
}

/** A config home whose `default` profile file holds `stored`, if given. */
const homeWith = async (stored?: StoredFile): Promise<string> => {
  homes += 1;
  const dir = join(home, String(homes));

  if (stored !== undefined) {
    await writePrivateFile(join(dir, "media", "sessions", "default.json"), JSON.stringify(stored));
  }

  return dir;
};

const SESSION = { token: "jwt", refreshToken: "refresh" };

const targetOf = (
  env: Readonly<Record<string, string>>,
  profile: Option.Option<string> = Option.none(),
) =>
  Effect.runPromise(
    resolveTarget(profile).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  );

describe("target resolution", () => {
  it("prefers the flag, then MEDIA_PROFILE, then default, each in its own file", async () => {
    const dir = await homeWith();
    const flag = await targetOf({ XDG_CONFIG_HOME: dir, MEDIA_PROFILE: "env" }, Option.some("tv"));
    const fromEnv = await targetOf({ XDG_CONFIG_HOME: dir, MEDIA_PROFILE: "env" });
    const fallback = await targetOf({ XDG_CONFIG_HOME: dir });

    expect([flag.profile, fromEnv.profile, fallback.profile]).toStrictEqual([
      "tv",
      "env",
      "default",
    ]);
    expect(flag.path).toBe(join(dir, "media", "sessions", "tv.json"));
  });

  it("finds the media server and its sign-in beside an install's core", async () => {
    const target = await targetOf({
      XDG_CONFIG_HOME: await homeWith({ url: "http://nas:8080/convex", session: SESSION }),
    });

    expect(target.url).toStrictEqual(Option.some("http://nas:8080/convex"));
    expect(target.mediaUrl).toStrictEqual(Option.some("http://nas:8080"));
    expect(target.signInUrl).toStrictEqual(Option.some("http://nas:8080/api/auth/sign-in"));
    expect(target.storage).toBe("file");
  });

  it("never stores the environment's addresses, and keeps the stored one for its core", async () => {
    const dir = await homeWith({ url: "http://nas:3210", mediaUrl: "http://nas:8080" });

    const target = await targetOf({
      XDG_CONFIG_HOME: dir,
      MEDIA_SERVER_URL: "http://media.local",
    });

    expect(target.mediaUrl).toStrictEqual(Option.some("http://media.local"));
    expect(target.savedMediaUrl).toStrictEqual(Option.some("http://nas:8080"));
    expect(retarget(target, "http://nas:3210", Option.none()).savedMediaUrl).toStrictEqual(
      Option.some("http://nas:8080"),
    );
    expect(retarget(target, "http://other:3210", Option.none()).savedMediaUrl).toStrictEqual(
      Option.none(),
    );
  });

  it("keeps a stored media server, and lets the environment name each address", async () => {
    const dir = await homeWith({
      url: "http://nas:3210",
      mediaUrl: "http://nas:8080",
      session: SESSION,
    });

    const stored = await targetOf({ XDG_CONFIG_HOME: dir });

    const overridden = await targetOf({
      XDG_CONFIG_HOME: dir,
      MEDIA_SERVER_URL: "http://media.local/",
      MEDIA_CORE_SIGN_IN_URL: "http://boundary.local/api/auth/sign-in",
    });

    expect(stored.mediaUrl).toStrictEqual(Option.some("http://nas:8080"));
    expect(stored.signInUrl).toStrictEqual(Option.some("http://nas:8080/api/auth/sign-in"));
    expect(overridden.mediaUrl).toStrictEqual(Option.some("http://media.local"));
    expect(overridden.signInUrl).toStrictEqual(
      Option.some("http://boundary.local/api/auth/sign-in"),
    );
  });

  it("keeps the stored session and media server away from another core in MEDIA_CORE_URL", async () => {
    const target = await targetOf({
      XDG_CONFIG_HOME: await homeWith({ url: "http://nas:3210", mediaUrl: "http://nas:8080" }),
      MEDIA_CORE_URL: "http://other:8080/convex",
    });

    expect(target.url).toStrictEqual(Option.some("http://other:8080/convex"));
    expect(target.mediaUrl).toStrictEqual(Option.some("http://other:8080"));
    expect(target.storage).toBe("memory");
  });

  it("signs in for one run with MEDIA_CORE_API_KEY, storing nothing", async () => {
    const target = await targetOf({
      XDG_CONFIG_HOME: await homeWith(),
      MEDIA_CORE_URL: "http://nas:3210",
      MEDIA_CORE_API_KEY: " mk_key ",
    });

    expect(Option.map(target.apiKey, Redacted.value)).toStrictEqual(Option.some("mk_key"));
    expect(target.storage).toBe("memory");
  });

  it("refuses an address that is not an http(s) URL", async () => {
    await expect(
      targetOf({ XDG_CONFIG_HOME: await homeWith(), MEDIA_SERVER_URL: "nas:8080" }),
    ).rejects.toThrow("MEDIA_SERVER_URL is not an http(s) URL");
  });

  it("points a login at the new core's media server unless one is named", async () => {
    const env = {
      XDG_CONFIG_HOME: await homeWith({ url: "http://old:3210", mediaUrl: "http://old:8080" }),
    };

    const target = await targetOf(env);

    const run = (url: string, mediaUrl: Option.Option<string>) => retarget(target, url, mediaUrl);

    const same = run("http://old:3210", Option.none());
    const moved = run("http://new:8080/convex", Option.none());
    const named = run("http://new:3210", Option.some("http://new:8080"));

    expect(same.mediaUrl).toStrictEqual(Option.some("http://old:8080"));
    expect(moved.mediaUrl).toStrictEqual(Option.some("http://new:8080"));
    expect(moved.signInUrl).toStrictEqual(Option.some("http://new:8080/api/auth/sign-in"));
    expect(named.signInUrl).toStrictEqual(Option.some("http://new:8080/api/auth/sign-in"));
  });
});

/** Answers a held media route request as the media server refuses a session. */
const refuse = (response: ServerResponse | undefined): void => {
  response?.writeHead(401, { "content-type": "application/json" });
  response?.end(JSON.stringify({ code: "unauthenticated", message: "Not this session" }));
};

describe("a refusal from the media server", () => {
  it("leaves a session another call renewed alone after a delayed refusal, and sends nothing again", async () => {
    const first = jwtExpiringAt(Date.now() + 3_600_000, "user-1|session-1");
    const renewed = jwtExpiringAt(Date.now() + 7_200_000, "user-1|session-1");
    const refreshes: Array<string> = [];
    const held: Array<ServerResponse> = [];
    const routed: Array<string> = [];

    const outcome = await withMediaService(
      (request, response) => {
        let body = "";

        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          const bearer = request.headers.authorization ?? "";

          if (request.url === "/api/action") {
            const refreshToken = /"refreshToken":"([^"]+)"/u.exec(body)?.[1] ?? "";

            const tokens =
              refreshToken === "refresh-1" ? { token: renewed, refreshToken: "refresh-2" } : null;

            refreshes.push(refreshToken);
            response.writeHead(200, { "content-type": "application/json" });
            // The second call's refusal leaves once the first one's refresh has answered.
            response.end(
              JSON.stringify({ status: "success", value: { tokens }, logLines: [] }),
              () => refuse(held[1]),
            );

            return;
          }

          routed.push(bearer === `Bearer ${renewed}` ? "renewed" : "first");

          if (bearer === `Bearer ${renewed}`) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end("[]");

            return;
          }

          held.push(response);

          if (held.length === 2) refuse(held[0]);
        });
      },
      async (url) => {
        const dir = await homeWith({
          url,
          session: { token: first, refreshToken: "refresh-1" },
        });

        const env = ConfigProvider.fromEnv({ env: { XDG_CONFIG_HOME: dir } });

        return Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const target = yield* resolveTarget(Option.none());
              const connection = yield* connect(target, "required");

              const sessions = () =>
                Effect.exit(
                  connection.media((routes) => MediaRoutes.run(routes, "diagnostics.sessions", {})),
                );

              const exits = yield* Effect.all([sessions(), sessions()], {
                concurrency: "unbounded",
              });

              return {
                exits: exits.map((exit) =>
                  Exit.isSuccess(exit)
                    ? "answered"
                    : Option.exists(Cause.findErrorOption(exit.cause), (error) =>
                          Predicate.isTagged(error, "Unauthenticated"),
                        )
                      ? "Unauthenticated"
                      : "other",
                ),
                status: yield* connection.platform.session.currentStatus,
              };
            }),
          ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, env)),
        );
      },
    );

    expect(refreshes).toStrictEqual(["refresh-1"]);
    expect(routed).toStrictEqual(["first", "first"]);
    expect(outcome.status).toBe("signedIn");
    expect(outcome.exits).toStrictEqual(["Unauthenticated", "Unauthenticated"]);
  });
});

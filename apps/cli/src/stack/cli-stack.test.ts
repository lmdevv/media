import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ExitCode } from "../cli-errors";
import { StoredConfig } from "../config";
import {
  buildCli,
  makeTempDir,
  readText,
  removeDir,
  runMovies,
  startMovies,
  writeText,
} from "../testing/process";
import { scanMovie, scanShow, signUp } from "../testing/stack-seed";
import { findStack } from "../testing/stack-env";

const stack = findStack();

const url = stack?.convexUrl ?? "";

const PASSWORD = "stack-test-password";

const id = Math.random().toString(36).slice(2, 8);

const homes: Array<string> = [];

const install = async (): Promise<Readonly<Record<string, string>>> => {
  const home = await makeTempDir("movies-cli-stack-");

  homes.push(home);

  return { XDG_CONFIG_HOME: home, HOME: home };
};

const parse =
  <A>(schema: Schema.Codec<A, unknown>) =>
  (stdout: string): A =>
    Schema.decodeSync(Schema.fromJsonString(schema))(stdout);

const Who = parse(
  Schema.Struct({
    viewingProfileId: Schema.NullOr(Schema.String),
    viewer: Schema.Struct({ sessionKind: Schema.String, scopes: Schema.Array(Schema.String) }),
  }),
);

const Secret = parse(Schema.Struct({ secret: Schema.String }));

const Profiles = parse(Schema.Array(Schema.Struct({ id: Schema.String })));

const DeviceCode = parse(
  Schema.Struct({ event: Schema.Literal("device_code"), userCode: Schema.String }),
);

const Created = parse(Schema.Struct({ libraryId: Schema.String }));

const InviteCode = parse(Schema.Struct({ code: Schema.String }));

const RoomCreated = parse(Schema.Struct({ id: Schema.String }));

const NextOf = parse(
  Schema.Struct({
    episode: Schema.NullOr(Schema.Struct({ id: Schema.String })),
    next: Schema.NullOr(
      Schema.Union([
        Schema.Struct({
          status: Schema.Literal("pending"),
          episode: Schema.Struct({ id: Schema.String }),
          nextAt: Schema.Finite,
        }),
        Schema.Struct({ status: Schema.Literal("cancelled") }),
      ]),
    ),
  }),
);

const Episodes = parse(Schema.Array(Schema.Struct({ id: Schema.String })));

const Clock = parse(Schema.Struct({ status: Schema.String, positionAtAnchorMs: Schema.Finite }));

const Titles = parse(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })));

const Progress = parse(
  Schema.Struct({ titleId: Schema.String, name: Schema.String, progress: Schema.Null }),
);

const SetupStatus = parse(Schema.Struct({ hasOwner: Schema.Boolean }));

const Versions = parse(
  Schema.Array(Schema.Struct({ id: Schema.String, versionName: Schema.NullOr(Schema.String) })),
);

const ActiveSessions = parse(
  Schema.Array(Schema.Struct({ deviceId: Schema.String, fileId: Schema.String })),
);

const WatchLine = parse(
  Schema.Struct({ room: Schema.Struct({ clock: Schema.Struct({ status: Schema.String }) }) }),
);

let owner: Readonly<Record<string, string>>;

const loginOwner = async (env: Readonly<Record<string, string>>): Promise<string> => {
  const login = (email: string) =>
    runMovies(["login", "--server", url, "--email", email, "--password"], env, PASSWORD);

  if ((await login("owner-a@movies.test")).code === 0) return "owner-a@movies.test";

  if ((await login("owner-b@movies.test")).code === 0) return "owner-b@movies.test";

  throw new Error("Could not sign in as the stack owner; use a fresh stack");
};

const configPath = (env: Readonly<Record<string, string>>): string =>
  join(env["XDG_CONFIG_HOME"] ?? "", "movies", "config.json");

const decodeConfig = Schema.decodeSync(Schema.fromJsonString(StoredConfig));

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(StoredConfig));

describe.skipIf(stack === undefined)("the media CLI against a real stack", () => {
  beforeAll(async () => {
    buildCli();
    owner = await install();

    const status = await runMovies(["setup", "status"], {
      ...(await install()),
      MEDIA_CONVEX_URL: url,
    });

    if (!SetupStatus(status.stdout).hasOwner) {
      await signUp(url, "owner-a@movies.test", PASSWORD, null);
    }

    await loginOwner(owner);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(homes.map(removeDir));
  });

  it("logs in with a password, stores the config privately, and answers whoami", async () => {
    const who = await runMovies(["whoami"], owner);

    expect(who.code).toBe(ExitCode.ok);
    expect(Who(who.stdout).viewer.sessionKind).toBe("password");
    expect(Who(who.stdout).viewingProfileId).not.toBeNull();

    const profiles = await runMovies(["profiles", "list", "--human"], owner);

    expect(profiles.stdout.split("\n")[0]).toMatch(/^ID\s+NAME/u);
  });

  it("logs in with an API key until the key is revoked", async () => {
    const created = await runMovies(
      ["keys", "create", `agent-${id}`, "--scopes", "read,play"],
      owner,
    );

    expect(created.code).toBe(ExitCode.ok);
    const { secret } = Secret(created.stdout);
    const agent = await install();

    expect((await runMovies(["login", "--server", url, "--api-key", secret], agent)).code).toBe(
      ExitCode.ok,
    );
    expect(Who((await runMovies(["whoami"], agent)).stdout).viewer).toStrictEqual({
      sessionKind: "apikey",
      scopes: ["read", "play"],
    });
    expect((await runMovies(["users", "list"], agent)).code).toBe(ExitCode.forbidden);

    expect((await runMovies(["keys", "revoke", `agent-${id}`], owner)).code).toBe(ExitCode.ok);

    const after = await runMovies(["whoami"], agent);

    expect(after.code).toBe(ExitCode.unauthenticated);
    expect(after.stderr).toContain('"code":"unauthenticated"');

    const fromEnv = await runMovies(["whoami"], {
      ...(await install()),
      MEDIA_CONVEX_URL: url,
      MEDIA_API_KEY: secret,
    });

    expect(fromEnv.code).toBe(ExitCode.unauthenticated);
  });

  it("signs out the stored session on logout even while MEDIA_API_KEY is set", async () => {
    const device = await install();

    await loginOwner(device);
    const saved = await readText(configPath(device));
    const created = await runMovies(["keys", "create", `logout-${id}`, "--scopes", "read"], owner);
    const withKey = { ...device, MEDIA_API_KEY: Secret(created.stdout).secret };

    expect((await runMovies(["logout"], withKey)).code).toBe(ExitCode.ok);

    await writeText(configPath(device), saved);
    expect((await runMovies(["whoami"], device)).code).toBe(ExitCode.unauthenticated);
  });

  it("logs in again to a profile saved with a trailing slash on its server", async () => {
    const device = await install();
    const email = await loginOwner(device);
    const before = decodeConfig(await readText(configPath(device)));
    const profile = before.profiles[before.defaultProfile];

    expect(profile?.viewingProfileId).toBeDefined();

    await writeText(
      configPath(device),
      encodeConfig({
        defaultProfile: before.defaultProfile,
        profiles: {
          [before.defaultProfile]: { deviceId: "cli-slash", ...profile, convexUrl: `${url}/` },
        },
      }),
    );

    const again = await runMovies(["login", "--email", email, "--password"], device, PASSWORD);

    expect(again.code, again.stderr).toBe(ExitCode.ok);

    const after = decodeConfig(await readText(configPath(device))).profiles[before.defaultProfile];

    expect(after?.deviceId).toBe(profile?.deviceId);
    expect(after?.viewingProfileId).toBe(profile?.viewingProfileId);
  });

  it("lets an agent on environment variables alone choose its profile once", async () => {
    const created = await runMovies(["keys", "create", `env-${id}`, "--scopes", "read"], owner);

    const agent = {
      ...(await install()),
      MEDIA_CONVEX_URL: url,
      MEDIA_API_KEY: Secret(created.stdout).secret,
    };

    expect((await runMovies(["search", "anything"], agent)).code).toBe(ExitCode.usage);

    const [first] = Profiles((await runMovies(["profiles", "list"], agent)).stdout);

    expect((await runMovies(["profiles", "use", first?.id ?? ""], agent)).code).toBe(ExitCode.ok);
    expect((await runMovies(["search", "anything"], agent)).code).toBe(ExitCode.ok);
    expect(Who((await runMovies(["whoami"], agent)).stdout).viewingProfileId).toBe(first?.id);

    const stored = await runMovies(["whoami"], { ...agent, MEDIA_API_KEY: "" });

    expect(stored.code).toBe(ExitCode.unauthenticated);
  });

  it("completes a device login approved from another session", async () => {
    const device = await install();
    const login = startMovies(["login", "--server", url], device);
    const event = DeviceCode(await login.nextErrorLine());

    const approve = await runMovies(
      ["device-auth", "approve", "--user-code", event.userCode, "--scopes", "read,play"],
      owner,
    );

    expect(approve.code).toBe(ExitCode.ok);
    expect((await login.done).code).toBe(ExitCode.ok);
    expect(Who((await runMovies(["whoami"], device)).stdout).viewer.sessionKind).toBe("device");
  });

  it("creates a library on a folder, scans a movie in, and runs a room for host and guest", async () => {
    const folder = await makeTempDir("movies-cli-library-");

    homes.push(folder);

    const library = await runMovies(
      ["libraries", "create", "--name", `CLI ${id}`, "--kind", "movies", "--roots", folder],
      owner,
    );

    expect(library.code).toBe(ExitCode.ok);
    const name = `CLI Room Movie ${id}`;

    await scanMovie(
      url,
      stack?.mediaServiceKey ?? "",
      Created(library.stdout).libraryId,
      join(folder, "movie.mp4"),
      name,
    );
    const [found] = Titles((await runMovies(["search", name], owner)).stdout);

    expect(found?.name).toBe(name);

    const progress = await Promise.all(
      [name, found?.id ?? ""].map((query) => runMovies(["progress", query], owner)),
    );

    for (const run of progress) {
      expect(Progress(run.stdout)).toStrictEqual({ titleId: found?.id, name, progress: null });
    }

    const email = `cli-guest-${id}@movies.test`;

    const invite = await runMovies(
      ["invites", "create", "--role", "member", "--email", email],
      owner,
    );

    await signUp(url, email, PASSWORD, InviteCode(invite.stdout).code);
    const guest = await install();

    expect(
      (await runMovies(["login", "--server", url, "--email", email, "--password"], guest, PASSWORD))
        .code,
    ).toBe(ExitCode.ok);

    const room = await runMovies(["rooms", "create", name], owner);

    expect(room.code).toBe(ExitCode.ok);
    const roomId = RoomCreated(room.stdout).id;

    expect((await runMovies(["rooms", "join", roomId], guest)).code).toBe(ExitCode.ok);

    const play = await runMovies(["rooms", "play", "--position", "30"], owner);

    expect(Clock(play.stdout)).toStrictEqual({ status: "playing", positionAtAnchorMs: 30_000 });

    const guestPause = await runMovies(["rooms", "pause", roomId], guest);

    expect(guestPause.code).toBe(ExitCode.forbidden);
    expect(guestPause.stderr).toContain('"code":"forbidden"');

    expect(Clock((await runMovies(["rooms", "pause"], owner)).stdout).status).toBe("paused");
    expect((await runMovies(["rooms", "status", roomId, "--human"], guest)).stdout).toContain(
      "paused",
    );

    const watch = startMovies(["rooms", "status", roomId, "--watch"], guest);

    expect((await runMovies(["rooms", "leave"], guest)).code).toBe(ExitCode.ok);
    expect((await runMovies(["rooms", "leave"], owner)).code).toBe(ExitCode.ok);

    const watched = await Promise.race([
      watch.done,
      delay(30_000).then(() => {
        watch.child.kill();

        return null;
      }),
    ]);

    expect(watched?.code, "rooms status --watch exits once the room ends").toBe(ExitCode.ok);

    const lines = (watched?.stdout ?? "").trimEnd().split("\n").map(WatchLine);

    expect(lines.at(-1)?.room.clock.status).toBe("ended");
  }, 120_000);

  it("moves a room on to the next episode: a countdown, its cancel, and Play next", async () => {
    const folder = await makeTempDir("movies-cli-show-");

    homes.push(folder);

    const library = await runMovies(
      ["libraries", "create", "--name", `CLI shows ${id}`, "--kind", "shows", "--roots", folder],
      owner,
    );

    const name = `CLI Room Show ${id}`;

    await scanShow(
      url,
      stack?.mediaServiceKey ?? "",
      Created(library.stdout).libraryId,
      folder,
      name,
      [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
      ],
    );

    const [show] = Titles((await runMovies(["search", name], owner)).stdout);

    const [first, second] = Episodes(
      (
        await runMovies(
          ["titles", "episodes", "--title-id", show?.id ?? "", "--season-number", "1"],
          owner,
        )
      ).stdout,
    );

    const room = await runMovies(
      ["rooms", "create", show?.id ?? "", "--episode-id", first?.id ?? ""],
      owner,
    );

    expect(room.code).toBe(ExitCode.ok);
    const roomId = RoomCreated(room.stdout).id;

    const counting = NextOf((await runMovies(["rooms", "countdown"], owner)).stdout);

    expect(counting.next).toMatchObject({ status: "pending", episode: { id: second?.id } });
    expect((await runMovies(["rooms", "status", roomId, "--human"], owner)).stdout).toMatch(
      /next episode: S1E2 Episode 2 in \d+s/u,
    );
    expect(
      NextOf((await runMovies(["rooms", "cancel-countdown"], owner)).stdout).next,
    ).toStrictEqual({ status: "cancelled" });

    const moved = NextOf((await runMovies(["rooms", "next"], owner)).stdout);

    expect(moved.episode?.id).toBe(second?.id);
    expect(moved.next).toBeNull();

    expect((await runMovies(["rooms", "next"], owner)).code).toBe(ExitCode.notFound);
    expect((await runMovies(["rooms", "leave"], owner)).code).toBe(ExitCode.ok);
  }, 120_000);

  it("plays the version a play names by its name or number, and says which ones exist", async () => {
    const folder = await makeTempDir("movies-cli-versions-");

    homes.push(folder);

    const library = await runMovies(
      [
        "libraries",
        "create",
        "--name",
        `CLI versions ${id}`,
        "--kind",
        "movies",
        "--roots",
        folder,
      ],
      owner,
    );

    const name = `CLI Versions Movie ${id}`;
    const libraryId = Created(library.stdout).libraryId;

    await Promise.all(
      [
        { name: "Theatrical", height: 1080 },
        { name: "Director's Cut", height: 2160 },
      ].map((version) =>
        scanMovie(
          url,
          stack?.mediaServiceKey ?? "",
          libraryId,
          join(folder, `movie {edition-${version.name}}.mkv`),
          name,
          version,
        ),
      ),
    );

    const [found] = Titles((await runMovies(["search", name], owner)).stdout);
    const titleId = found?.id ?? "";

    const listed = Versions(
      (await runMovies(["titles", "versions", "--title-id", titleId], owner)).stdout,
    );

    expect(listed.map((version) => version.versionName)).toStrictEqual([
      "Director's Cut",
      "Theatrical",
    ]);

    const sessionFile = async (choice: string): Promise<string | undefined> => {
      await runMovies(["play", name, "--version", choice], owner);

      const sessions = ActiveSessions((await runMovies(["playback", "active"], owner)).stdout);

      return sessions.find((session) => session.deviceId.startsWith("cli-"))?.fileId;
    };

    expect(await sessionFile("theatrical")).toBe(listed[1]?.id);
    expect(await sessionFile("1")).toBe(listed[0]?.id);

    const unknown = await runMovies(["play", name, "--version", "extended"], owner);

    expect(unknown.code).toBe(ExitCode.notFound);
    expect(unknown.stderr).toContain("1. Director's Cut, 2. Theatrical");
  }, 120_000);

  it("reports an unknown viewing profile or API key as not found", async () => {
    const profile = await runMovies(["profiles", "use", `missing-${id}`], owner);

    expect(profile.code).toBe(ExitCode.notFound);
    expect(profile.stderr).toContain('"code":"not_found"');

    const key = await runMovies(["keys", "revoke", `missing-${id}`], owner);

    expect(key.code).toBe(ExitCode.notFound);
    expect(key.stderr).toContain('"code":"not_found"');
  });
});

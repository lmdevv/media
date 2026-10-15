/**
 * Runs the built `music` binary as a subprocess against a real [music] server. Set
 * MUSIC_E2E_SERVER to a Convex URL (for example from `scripts/dev-backend.sh cli 3610`) to run;
 * without it the suite is skipped. The first run signs up the server's first user, which becomes
 * the owner, so point it at a fresh backend or reuse MUSIC_E2E_EMAIL / MUSIC_E2E_PASSWORD.
 *
 * With MUSIC_E2E_MEDIA_SECRET (the server's MEDIA_SERVICE_SECRET) set as well, a fake media
 * service completes a library scan with a small catalog, which covers `--wait` success, `play`,
 * `now`, and likes against real data.
 */
import { join } from "node:path";

import { commands } from "@music/commands/registry";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Session } from "./config";
import type { Run } from "./testing/process";
import {
  buildCli,
  makeTempDir,
  permissions,
  readText,
  removeDir,
  runMusic,
  writeText,
} from "./testing/process";

const server = process.env["MUSIC_E2E_SERVER"];

const email = process.env["MUSIC_E2E_EMAIL"] ?? "e2e-admin@music.test";

const password = process.env["MUSIC_E2E_PASSWORD"] ?? "e2e-password-1234";

const mediaSecret = process.env["MUSIC_E2E_MEDIA_SECRET"];

const signInAction = makeFunctionReference<
  "action",
  { provider: "password"; params: { email: string; password: string; flow: string; name: string } },
  { tokens: { token: string } | null }
>("auth:signIn");

const invitesCreate = makeFunctionReference<
  "mutation",
  { name: "invites.create"; args: Record<string, never> },
  { code: string }
>("commands:run");

const apiKeySignIn = makeFunctionReference<
  "action",
  { provider: "apikey"; params: { key: string } },
  { tokens: { token: string } | null }
>("auth:signIn");

const memberSignUp = makeFunctionReference<
  "action",
  {
    provider: "password";
    params: { email: string; password: string; flow: string; name: string; inviteCode: string };
  },
  { tokens: { token: string } | null }
>("auth:signIn");

const keysCreate = makeFunctionReference<
  "mutation",
  { name: "keys.create"; args: { name: string } },
  { key: string }
>("commands:run");

const pendingJobs = makeFunctionReference<
  "query",
  { secret: string },
  ReadonlyArray<{ jobId: string; kind: string }>
>("media:pendingJobs");

const claimJob = makeFunctionReference<
  "mutation",
  { secret: string; jobId: string; workerId: string },
  { jobId: string; library: { id: string; path: string } } | null
>("media:claimJob");

const claimRoot = makeFunctionReference<
  "mutation",
  {
    secret: string;
    libraryId: string;
    realPath: string;
    rootIds: ReadonlyArray<string>;
    fsPath: string | null;
    bootId: string | null;
  },
  { ok: boolean }
>("media:claimRoot");

const reportJob = makeFunctionReference<
  "mutation",
  { secret: string; jobId: string; workerId: string; done: number; total: number; message: string },
  { cancelled: boolean }
>("media:reportJob");

const upsertTracks = makeFunctionReference<
  "mutation",
  {
    secret: string;
    libraryId: string;
    tracks: ReadonlyArray<{
      path: string;
      size: number;
      mtimeMs: number;
      title: string;
      artist: string;
      album: string;
      trackNumber: number;
      year: number;
      durationMs: number;
      codec: string;
      lossless: boolean;
    }>;
  },
  { upserted: number }
>("media:upsertTracks");

const finishJob = makeFunctionReference<
  "mutation",
  { secret: string; jobId: string; workerId: string; status: "done" },
  null
>("media:finishJob");

const catalogTracks = [
  ["Daft Punk", "Discovery", "One More Time", 320_000],
  ["Daft Punk", "Discovery", "Aerodynamic", 212_000],
  ["Daft Punk", "Discovery", "Digital Love", 301_000],
  ["The Beatles", "Abbey Road", "Come Together", 259_000],
  ["The Beatles", "Abbey Road", "Something", 182_000],
] as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls for the next pending job, as the real service's subscription would deliver it. */
const nextPendingJob = async (
  client: ConvexHttpClient,
  secret: string,
  attemptsLeft: number,
): Promise<string> => {
  const [job] = await client.query(pendingJobs, { secret });

  if (job !== undefined) return job.jobId;

  if (attemptsLeft === 0) throw new Error("No scan job appeared for the fake media service");

  await sleep(100);

  return nextPendingJob(client, secret, attemptsLeft - 1);
};

/**
 * Stands in for the media service: waits for the next scan job, reports progress, upserts a small
 * catalog, and finishes the job, through the same Convex functions the real service calls.
 */
const completeNextScan = async (url: string, secret: string): Promise<void> => {
  const client = new ConvexHttpClient(url, { logger: false });
  const workerId = "e2e-fake-media";
  const jobId = await nextPendingJob(client, secret, 100);
  const claimed = await client.mutation(claimJob, { secret, jobId, workerId });

  if (claimed === null) throw new Error("The fake media service lost the job");

  const progress = { secret, jobId, workerId, total: catalogTracks.length };

  // The real service claims the library's folder before reading it; the identity is made up.
  const root = await client.mutation(claimRoot, {
    secret,
    libraryId: claimed.library.id,
    realPath: claimed.library.path,
    rootIds: [`e2e:${claimed.library.id}`],
    fsPath: null,
    bootId: null,
  });

  if (!root.ok) throw new Error("The fake media service's folder claim was refused");

  await client.mutation(reportJob, { ...progress, done: 0, message: "reading tags" });

  await client.mutation(upsertTracks, {
    secret,
    libraryId: claimed.library.id,
    tracks: catalogTracks.map(([artist, album, title, durationMs], index) => ({
      path: `/e2e/${artist}/${album}/${String(index + 1)} ${title}.flac`,
      size: 1000 + index,
      mtimeMs: 1_700_000_000_000,
      title,
      artist,
      album,
      trackNumber: index + 1,
      year: 2001,
      durationMs,
      codec: "flac",
      lossless: true,
    })),
  });

  await client.mutation(reportJob, { ...progress, done: catalogTracks.length, message: "saved" });
  await client.mutation(finishJob, { secret, jobId, workerId, status: "done" });
};

/** Signs up a member through an admin invite and returns an API key for them. */
const createMemberKey = async (url: string, adminKey: string): Promise<string> => {
  const admin = new ConvexHttpClient(url, { logger: false });

  const adminSession = await admin.action(apiKeySignIn, {
    provider: "apikey",
    params: { key: adminKey },
  });

  if (adminSession.tokens === null) throw new Error("The admin key did not sign in");

  admin.setAuth(adminSession.tokens.token);

  const invite = await admin.mutation(invitesCreate, { name: "invites.create", args: {} });
  const member = new ConvexHttpClient(url, { logger: false });

  const signedUp = await member.action(memberSignUp, {
    provider: "password",
    params: {
      email: `member-${String(Date.now())}@music.test`,
      password,
      flow: "signUp",
      name: "E2E Member",
      inviteCode: invite.code,
    },
  });

  if (signedUp.tokens === null) throw new Error("The member could not sign up");

  member.setAuth(signedUp.tokens.token);

  const created = await member.mutation(keysCreate, {
    name: "keys.create",
    args: { name: "member" },
  });

  return created.key;
};

/** Signs in (or, on a fresh server, signs up) the admin and creates an API key for the CLI. */
const createAdminKey = async (url: string): Promise<string> => {
  const client = new ConvexHttpClient(url, { logger: false });

  const attempt = (flow: "signIn" | "signUp") =>
    client.action(signInAction, {
      provider: "password",
      params: { email, password, flow, name: "E2E Admin" },
    });

  const result = await attempt("signIn").catch(() => attempt("signUp"));

  if (result.tokens === null) throw new Error(`Could not sign in ${email}`);

  client.setAuth(result.tokens.token);

  const created = await client.mutation(keysCreate, {
    name: "keys.create",
    args: { name: `e2e ${String(Date.now())}` },
  });

  return created.key;
};

const parse = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string,
): S["Type"] => Schema.decodeSync(Schema.fromJsonString(schema))(text);

const ErrorOutput = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

const errorOf = (run: Run) => parse(ErrorOutput, run.stderr).error;

const StoredConfig = Schema.Struct({ server: Schema.String, key: Schema.String });

const CatalogOutput = Schema.Array(
  Schema.Struct({ name: Schema.String, args: Schema.Struct({ type: Schema.Literal("object") }) }),
);

const JobList = commands["jobs.list"].result;

describe.skipIf(server === undefined)("music against a real server", () => {
  const url = server ?? "";
  let home = "";
  let key = "";

  const music = (
    args: ReadonlyArray<string>,
    env: Readonly<Record<string, string>> = {},
    stdin = "",
  ) => runMusic(args, { HOME: home, XDG_CONFIG_HOME: home, ...env }, stdin);

  beforeAll(async () => {
    buildCli();
    home = await makeTempDir("music-cli-e2e-");
    key = await createAdminKey(url);
  }, 60_000);

  afterAll(() => removeDir(home));

  it("logs in with a key piped to stdin, stores it privately, and reports the user", async () => {
    const login = await music(["login", "--server", url, "--key-stdin"], {}, `${key}\n`);

    expect(login.stderr).toContain("Saved to");
    expect(login.code).toBe(0);
    expect(login.stdout).toContain(`as ${email} (owner)`);

    const configFile = join(home, "music", "config.json");

    expect(await permissions(configFile)).toBe(0o600);
    expect(await permissions(join(home, "music", "session.json"))).toBe(0o600);
    expect(parse(StoredConfig, await readText(configFile))).toEqual({ server: url, key });

    const whoami = await music(["whoami", "--json"]);

    expect(whoami.code).toBe(0);
    expect(parse(commands["account.me"].result, whoami.stdout)).toMatchObject({
      email,
      role: "owner",
    });
  });

  it("creates a playlist and lists it", async () => {
    const name = `E2E ${String(Date.now())}`;
    const created = await music(["playlists", "create", name, "--json"]);

    expect(created.code).toBe(0);

    const { playlistId } = parse(commands["playlists.create"].result, created.stdout);
    const listed = await music(["playlists", "list", "--json"]);

    expect(listed.code).toBe(0);
    expect(parse(commands["playlists.list"].result, listed.stdout)).toContainEqual(
      expect.objectContaining({ id: playlistId, name, trackCount: 0 }),
    );

    const table = await music(["playlists", "list"]);

    expect(table.stdout).toMatch(/^ID\s+NAME\s+SONGS\s+TIME\s+UPDATED/u);
    expect(table.stdout).toContain(name);
  });

  it("rejects bad usage with exit code 2 before contacting the server", async () => {
    const missing = await music(["playlists", "create"]);

    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Missing --name");

    const invalid = await music(["playback", "volume", "2", "--json"]);

    expect(invalid.code).toBe(2);
    expect(errorOf(invalid)).toEqual({
      code: "usage",
      message: "--volume: Expected a value between 0 and 1",
    });

    const unknown = await music(["playlists", "create", "x", "--colour", "red"]);

    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Unknown option '--colour'");
  });

  it("reports server failures with exit code 1 and the server's code", async () => {
    const result = await music(["playlists", "get", "missing-id", "--json"]);

    expect(result.code).toBe(1);
    expect(errorOf(result).code).toBe("not_found");
  });

  it("exits 3 for a key the server rejects", async () => {
    const badKey = "mk_this-key-does-not-exist-anywhere";
    const fromEnv = await music(["whoami", "--json"], { MUSIC_API_KEY: badKey });

    expect(fromEnv.code).toBe(3);
    expect(errorOf(fromEnv).code).toBe("invalid_key");
    expect((await music(["login", "--server", url, "--key", badKey])).code).toBe(3);
    expect((await music(["login", "--server", url], { MUSIC_API_KEY: badKey })).code).toBe(3);
  });

  it("explains where the key comes from when none is given and nobody is at a terminal", async () => {
    // Stdin is a pipe, so a prompt would wait for nobody.
    const result = await music(["login", "--server", url]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("pipe it to --key-stdin, or set MUSIC_API_KEY");
  });

  it("exits 3 with forbidden when a member runs an admin command", async () => {
    const memberKey = await createMemberKey(url, key);
    const result = await music(["people", "list", "--json"], { MUSIC_API_KEY: memberKey });

    expect(result.code).toBe(3);
    expect(errorOf(result)).toEqual({ code: "forbidden", message: "Only an admin can do that" });
  });

  it("suspends a member, which locks their key out until they are unsuspended", async () => {
    const asMember = { MUSIC_API_KEY: await createMemberKey(url, key) };
    const whoami = await music(["whoami", "--json"], asMember);
    const member = parse(commands["account.me"].result, whoami.stdout);

    const table = await music(["people", "list"]);

    expect(table.stdout).toMatch(/^ID\s+EMAIL\s+NAME\s+ROLE\s+SUSPENDED\s+LAST ACTIVE/u);
    expect((await music(["people", "suspend", member.id])).code).toBe(0);

    const locked = await music(["whoami", "--json"], asMember);

    expect(locked.code).toBe(3);
    expect(errorOf(locked)).toEqual({
      code: "forbidden",
      message: "This account is suspended. Ask an admin on this server.",
    });

    expect((await music(["people", "unsuspend", member.id])).code).toBe(0);
    expect((await music(["whoami", "--json"], asMember)).code).toBe(0);
  });

  it("signs in again when the cached token is rejected", async () => {
    const sessionFile = join(home, "music", "session.json");
    const session = parse(Session, await readText(sessionFile));

    await writeText(sessionFile, JSON.stringify({ ...session, token: "a.b.c" }));

    expect((await music(["whoami", "--json"])).code).toBe(0);
    expect(parse(Session, await readText(sessionFile)).token).not.toBe("a.b.c");
  });

  it("waits on jobs and fails with a typed code when the job does not finish", async () => {
    const result = await music([
      "libraries",
      "create",
      "--name",
      "E2E library",
      "--path",
      `/nonexistent/e2e-${String(Date.now())}`,
      "--wait",
      "--timeout",
      "1",
      "--json",
    ]);

    expect(result.code).toBe(1);
    // Without a media service the scan never starts; with one it fails on the missing path.
    expect(["timeout", "job_failed"]).toContain(errorOf(result).code);

    const jobs = parse(JobList, (await music(["jobs", "list", "--json"])).stdout);
    const open = jobs.filter((job) => job.status === "pending" || job.status === "running");
    const cancelled = await Promise.all(open.map((job) => music(["jobs", "cancel", job.id])));

    expect(cancelled.map((run) => run.code)).toEqual(open.map(() => 0));
  });

  it("describes playback and lists commands for agents", async () => {
    const now = await music(["now"]);

    expect(now.code).toBe(0);
    // A fresh server has nothing playing; a reused one may still hold an earlier session.
    expect(now.stdout).toMatch(/^(Nothing is playing\.|[▶⏸] )/u);

    const catalog = parse(CatalogOutput, (await music(["commands", "--json"])).stdout);

    expect(catalog.map((entry) => entry.name)).toEqual(Object.keys(commands));
  });

  it.skipIf(mediaSecret === undefined)(
    "waits for a scan to finish, then plays, likes, and pauses from the catalog",
    async () => {
      const scanner = completeNextScan(url, mediaSecret ?? "");

      const created = await music([
        "libraries",
        "create",
        "--name",
        "E2E catalog",
        "--path",
        `/e2e-${String(Date.now())}`,
        "--wait",
        "--timeout",
        "30",
      ]);

      await scanner;

      // Polling can skip intermediate states, but the last progress line is the finished job.
      expect(created.stderr.trim().split("\n").at(-1)).toBe("Scan E2E catalog: done 5/5");
      expect(created.code).toBe(0);
      expect(created.stdout).toContain("status: done");

      const albums = await music(["albums", "list"]);

      expect(albums.stdout).toMatch(/^ID\s+TITLE\s+ARTIST\s+YEAR\s+SONGS/u);
      expect(albums.stdout).toContain("Discovery");

      const album = await music(["play", "discovery", "--json"]);

      expect(album.code).toBe(0);
      expect(album.stdout).toContain('"kind": "album"');

      const song = await music(["play", "something", "by", "the", "beatles"]);

      expect(song.stdout).toMatch(/^Playing Something by The Beatles \(\d+ songs?\)\.\n$/u);

      const state = parse(
        commands["playback.state"].result,
        (await music(["now", "--json"])).stdout,
      );

      const current = state.queue[state.index];

      expect(current?.title).toBe("Something");
      expect(state.playing).toBe(true);
      expect((await music(["now"])).stdout).toMatch(/^▶ Something — The Beatles/u);

      expect((await music(["likes", "set", current?.id ?? "", "--liked"])).code).toBe(0);

      const likes = parse(
        commands["likes.list"].result,
        (await music(["likes", "list", "--json"])).stdout,
      );

      // Newest like first.
      expect(likes[0]?.id).toBe(current?.id);

      expect((await music(["pause"])).stdout).toBe("Paused.\n");
      expect(
        parse(commands["playback.state"].result, (await music(["now", "--json"])).stdout).playing,
      ).toBe(false);
    },
    60_000,
  );

  it("logs out", async () => {
    expect((await music(["logout"])).code).toBe(0);
    expect((await music(["whoami"])).code).toBe(3);
  });
});

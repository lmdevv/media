import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  HOST_ABANDON_TIMEOUT_MS,
  NEXT_EPISODE_COUNTDOWN_MS,
  PLAYER_SILENCE_MS,
} from "@media/contracts/clock";
import type { AnyCommand } from "@media/contracts/command";
import type { CommandArgs } from "@media/contracts/commands";
import { commands } from "@media/contracts/commands";
import type {
  DeviceId,
  JobId,
  LibraryId,
  PersonId,
  PlaybackSessionId,
  ProfileId,
  RoomId,
  TitleId,
  UserId,
} from "@media/contracts/ids";
import type { CatalogFile, WatchStateImport } from "@media/contracts/models/migration-service";
import {
  DeviceId as DeviceIdSchema,
  EpisodeId as EpisodeIdSchema,
  JobId as JobIdSchema,
  RoomId as RoomIdSchema,
} from "@media/contracts/ids";
import type { TitleCard } from "@media/contracts/models/catalog";
import {
  type ScannedEpisode as ScannedEpisodeSchema,
  ScannedItem,
  type ScannedTitle as ScannedTitleSchema,
} from "@media/contracts/models/scan";
import {
  importPlaybackTokenSecret,
  PLAYBACK_TOKEN_LIFETIME_MS,
  verifyPlaybackToken,
} from "@media/contracts/playback-token";
import { mediaServiceFunctions } from "@media/contracts/media-service";
import type { CommandAccess } from "@media/contracts/scopes";
import { Bytes, EpochMillis, Milliseconds } from "@media/contracts/units";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { Effect, Match, Redacted, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import type { Session, SignInParams } from "./harness";
import { anonymous, outcome, run, runId, service, signIn, trySignIn } from "./harness";
import type { PublicFunction } from "./public-functions";
import { publicFunctions, sampleValue, tablesIn } from "./public-functions";
import { findStack, importDocuments, runInternal, sampleIds, tableLines } from "./stack-env";

const stack = findStack();

const url = stack?.convexUrl ?? "";

const PASSWORD = "stack-test-password";

const OWNER_RACERS = ["owner-a@movies.test", "owner-b@movies.test"] as const;

const id = runId();

const TOKEN = `run${id}`;

const decodeItem = Schema.decodeUnknownSync(ScannedItem);

const toArgs = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

const ms = (value: number): Milliseconds => Milliseconds.make(value);

const direct = (
  session: Session,
  kind: "query" | "mutation" | "action",
  path: string,
  args: Record<string, Value>,
) =>
  Match.value(kind).pipe(
    Match.when("query", () =>
      session.client.query(makeFunctionReference<"query", typeof args>(path), args),
    ),
    Match.when("mutation", () =>
      session.client.mutation(makeFunctionReference<"mutation", typeof args>(path), args),
    ),
    Match.when("action", () =>
      session.client.action(makeFunctionReference<"action", typeof args>(path), args),
    ),
    Match.exhaustive,
  );

const serialPath = (code: string): string => `/stack-${id}/open/serial/${code}.mp4`;

const long = (length: number): string => "x".repeat(length);

const sha256 = (secret: string): string => createHash("sha256").update(secret).digest("hex");

const decodeRow = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ status: Schema.String })),
);

const decodeId = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ _id: Schema.String })),
);

const decodeHostPresence = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ status: Schema.String, hostAway: Schema.Boolean })),
);

const decodeWatchedAt = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ presence: Schema.optionalKey(Schema.String), watchedAt: Schema.Finite }),
  ),
);

const idOf = (line: string): string => decodeId(line)._id;

const rowOf = (table: string, needle: string) =>
  decodeRow(tableLines(table).find((line) => line.includes(needle)) ?? "{}");

const device = (name: string): DeviceId => DeviceIdSchema.make(`${name}-${id}`);

const DURATION_MS = 600_000;

type Encoded<Item> = Item extends { readonly Encoded: infer E } ? E : never;

interface ScanExtras {
  readonly sizeBytes?: number;
  readonly version?: {
    readonly name: string;
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly hdr: "none" | "hdr10";
  };
  readonly title?: Partial<Encoded<typeof ScannedTitleSchema>>;
  readonly episode?: Partial<Encoded<typeof ScannedEpisodeSchema>>;
}

const scanned = (
  path: string,
  title: {
    readonly kind: "movie" | "show";
    readonly name: string;
    readonly ageRating: number | null;
  },
  episode: { readonly season: number; readonly episode: number } | null,
  extras: ScanExtras = {},
): ScannedItem =>
  decodeItem({
    file: {
      path,
      sizeBytes: extras.sizeBytes ?? 1_000_000,
      mtimeMs: 1_760_000_000_000,
      probe: {
        container: "mp4",
        durationMs: DURATION_MS,
        bitRate: 5_000_000,
        video: [
          {
            index: 0,
            codec: extras.version?.codec ?? "h264",
            profile: "High",
            width: extras.version?.width ?? 1920,
            height: extras.version?.height ?? 1080,
            frameRate: 23.976,
            bitDepth: extras.version?.hdr === "hdr10" ? 10 : 8,
            pixelFormat: "yuv420p",
            hdr: extras.version?.hdr ?? "none",
            bitRate: null,
          },
        ],
        audio: [],
        subtitles: [],
      },
      externalSubtitles: [],
      versionName: extras.version?.name ?? null,
    },
    title: {
      kind: title.kind,
      matchKey: `local:${title.name.toLowerCase()}`,
      name: title.name,
      sortName: null,
      year: 2024,
      overview: null,
      tagline: null,
      genres: [],
      certification: null,
      ageRating: title.ageRating,
      runtimeMs: DURATION_MS,
      artwork: { poster: null, backdrop: `backdrop-${id}`, logo: null },
      externalIds: { tmdb: null, imdb: null, tvdb: null },
      matchStatus: "unmatched",
      ...extras.title,
    },
    episode:
      episode === null
        ? null
        : {
            seasonNumber: episode.season,
            episodeNumber: episode.episode,
            name: `Episode ${episode.episode}`,
            overview: null,
            airDate: null,
            runtimeMs: DURATION_MS,
            still: null,
            seasonName: null,
            seasonPoster: null,
            ...extras.episode,
          },
  });

const password = (email: string, flow: "signUp" | "signIn", inviteCode?: string): SignInParams => ({
  provider: "password",
  params:
    inviteCode === undefined
      ? { flow, email, password: PASSWORD }
      : { flow, email, password: PASSWORD, inviteCode },
});

interface Fixture {
  readonly race: ReadonlyArray<string> | null;
  readonly owner: Session;
  readonly member: Session;
  readonly memberEmail: string;
  readonly mediaService: Session;
  readonly readKey: Session;
  readonly memberProfile: ProfileId;
  readonly ownerProfile: ProfileId;
  readonly kidsProfile: ProfileId;
  readonly openLibrary: LibraryId;
  readonly restrictedLibrary: LibraryId;
  readonly titles: {
    readonly allAges: TitleId;
    readonly adult: TitleId;
    readonly unrated: TitleId;
    readonly show: TitleId;
    readonly hidden: TitleId;
  };
}

const setUpOwner = async (): Promise<{
  readonly race: ReadonlyArray<string> | null;
  readonly owner: Session;
}> => {
  const status = await run(anonymous(url), "setup.status", {});

  if (!status.hasOwner) {
    const attempts = OWNER_RACERS.map((email) => signIn(url, password(email, "signUp")));
    const codes = await Promise.all(attempts.map(outcome));
    const settled = await Promise.allSettled(attempts);
    const winner = settled.find((attempt) => attempt.status === "fulfilled");

    if (winner === undefined) throw new Error("Neither first sign-up succeeded");

    return { race: codes, owner: winner.value };
  }

  const sessions = await Promise.all(
    OWNER_RACERS.map((email) => trySignIn(url, password(email, "signIn")).catch(() => null)),
  );

  const owner = sessions.find((session) => session !== null);

  if (owner === undefined) {
    throw new Error(
      "The backend already has an owner from elsewhere; point the suite at a fresh stack",
    );
  }

  return { race: null, owner };
};

const inviteMember = async (owner: Session, email: string): Promise<Session> => {
  const created = await run(owner, "invites.create", { email, role: "member" });

  return signIn(url, password(email, "signUp", created.code));
};

const firstProfile = async (session: Session): Promise<ProfileId> => {
  const [profile] = await run(session, "profiles.list", {});

  if (profile === undefined) throw new Error("A new account has no profile");

  return profile.id;
};

const titleNamed = async (
  session: Session,
  profileId: ProfileId,
  name: string,
): Promise<TitleCard> => {
  const results = await run(session, "titles.search", { profileId, query: name, limit: 50 });
  const found = results.find((title) => title.name === name);

  if (found === undefined) throw new Error(`${name} is not visible to this profile`);

  return found;
};

const setUp = async (): Promise<Fixture> => {
  if (stack === undefined) throw new Error("No stack");
  const { race, owner } = await setUpOwner();
  const memberEmail = `member-${id}@movies.test`;
  const member = await inviteMember(owner, memberEmail);

  const mediaService = await signIn(url, {
    provider: "apikey",
    params: { key: stack.mediaServiceKey },
  });

  const readOnly = await run(owner, "apiKeys.create", { name: `Read ${id}`, scopes: ["read"] });
  const readKey = await signIn(url, { provider: "apikey", params: { key: readOnly.secret } });

  const open = await run(owner, "libraries.create", {
    name: `Open ${id}`,
    kind: "mixed",
    roots: [`/stack-${id}/open`],
  });

  const restricted = await run(owner, "libraries.create", {
    name: `Restricted ${id}`,
    kind: "movies",
    roots: [`/stack-${id}/restricted`],
    access: "restricted",
  });

  await service(mediaService, "mediaService.upsertScanned", {
    libraryId: open.libraryId,
    items: [
      scanned(
        `/stack-${id}/open/all-ages.mp4`,
        { kind: "movie", name: `All Ages ${TOKEN}`, ageRating: 0 },
        null,
      ),
      scanned(
        `/stack-${id}/open/adult.mp4`,
        { kind: "movie", name: `Adult ${TOKEN}`, ageRating: 17 },
        null,
      ),
      scanned(
        `/stack-${id}/open/unrated.mp4`,
        { kind: "movie", name: `Unrated ${TOKEN}`, ageRating: null },
        null,
      ),
      scanned(
        `/stack-${id}/open/show/s01e01.mp4`,
        { kind: "show", name: `Show ${TOKEN}`, ageRating: 7 },
        { season: 1, episode: 1 },
      ),
      scanned(
        `/stack-${id}/open/show/s01e02.mp4`,
        { kind: "show", name: `Show ${TOKEN}`, ageRating: 7 },
        { season: 1, episode: 2 },
      ),
    ],
  });

  await service(mediaService, "mediaService.upsertScanned", {
    libraryId: restricted.libraryId,
    items: [
      scanned(
        `/stack-${id}/restricted/hidden.mp4`,
        { kind: "movie", name: `Hidden ${TOKEN}`, ageRating: 0 },
        null,
      ),
    ],
  });

  const ownerProfile = await firstProfile(owner);
  const memberProfile = await firstProfile(member);

  const kids = await run(member, "profiles.create", {
    name: `Kids ${id}`,
    avatar: "fox",
    kids: true,
  });

  return {
    race,
    owner,
    member,
    memberEmail,
    mediaService,
    readKey,
    memberProfile,
    ownerProfile,
    kidsProfile: kids.id,
    openLibrary: open.libraryId,
    restrictedLibrary: restricted.libraryId,
    titles: {
      allAges: (await titleNamed(owner, ownerProfile, `All Ages ${TOKEN}`)).id,
      adult: (await titleNamed(owner, ownerProfile, `Adult ${TOKEN}`)).id,
      unrated: (await titleNamed(owner, ownerProfile, `Unrated ${TOKEN}`)).id,
      show: (await titleNamed(owner, ownerProfile, `Show ${TOKEN}`)).id,
      hidden: (await titleNamed(owner, ownerProfile, `Hidden ${TOKEN}`)).id,
    },
  };
};

const plan = (
  serverId: string,
  users: ReadonlyArray<{ readonly sourceUserId: string; readonly profileId: ProfileId }>,
) => ({
  sourceUrl: "http://jellyfin.test:8096",
  serverId,
  credentials: { version: 1 as const, nonce: "bm9uY2U", ciphertext: "c2VhbGVk" },
  users: users.map((user) => ({ ...user, history: "full" as const })),
  libraries: [],
  pathMappings: [],
});

const claimMigration = async (
  fixture: Fixture,
  owner: UserId,
  serverId: string,
): Promise<{ readonly jobId: JobId; readonly worker: string }> => {
  const { jobId } = await service(fixture.mediaService, "migrationService.start", {
    requestedBy: owner,
    source: "jellyfin",
    serverName: "Jellyfin",
    plan: plan(serverId, [{ sourceUserId: "source-owner", profileId: fixture.ownerProfile }]),
  });

  const worker = `migrator-${serverId}`;

  await service(fixture.mediaService, "mediaService.claimJob", {
    jobId,
    workerId: worker,
    leaseMs: 60_000,
  });

  return { jobId, worker };
};

const catalogFiles = async (session: Session): Promise<ReadonlyArray<CatalogFile>> => {
  const read = async (
    cursor: string | null,
    found: ReadonlyArray<CatalogFile>,
  ): Promise<ReadonlyArray<CatalogFile>> => {
    const page = await service(session, "migrationService.catalog", { cursor, limit: 100 });
    const all = [...found, ...page.items];

    return page.nextCursor === null ? all : read(page.nextCursor, all);
  };

  return read(null, []);
};

const at = (offset: number) => EpochMillis.make(1_760_000_000_000 + offset);

const roomOf = (hostDeviceId: string): RoomId =>
  RoomIdSchema.make(idOf(tableLines("rooms").find((line) => line.includes(hostDeviceId)) ?? "{}"));

const memberOn = async (fixture: Fixture, roomId: RoomId, deviceId: DeviceId) => {
  const { members } = await run(fixture.owner, "rooms.get", { roomId });
  const found = members.find((each) => each.deviceId === deviceId);

  if (found === undefined) throw new Error(`No member on ${deviceId}`);

  return found;
};

const fileAt = async (fixture: Fixture, path: string): Promise<CatalogFile> => {
  const found = (await catalogFiles(fixture.mediaService)).find((file) => file.path === path);

  if (found === undefined) throw new Error(`${path} is not in the catalog`);

  return found;
};

const progressOf = async (fixture: Fixture, titleId: TitleId, episodeId: string | null) => {
  const page = await service(fixture.mediaService, "migrationService.localProgress", {
    profileId: fixture.ownerProfile,
    limit: 100,
  });

  return page.items.find((row) => row.titleId === titleId && row.episodeId === episodeId);
};

interface Member {
  readonly session: Session;
  readonly profile: ProfileId;
}

const creditedPerson = (name: string, tmdb: string | null) => ({
  name: `${name} ${TOKEN}`,
  externalIds: { tmdb: tmdb === null ? null : `${tmdb}${id}`, imdb: null, tvdb: null },
  profile: null,
});

const actor = (name: string, tmdb: string | null, order: number) => ({
  person: creditedPerson(name, tmdb),
  kind: "actor" as const,
  role: `Role of ${name}`,
  order,
});

const rescan = async (
  mediaService: Session,
  library: LibraryId,
  path: string,
  title: { readonly name: string; readonly ageRating: number | null },
  extras: NonNullable<ScanExtras["title"]>,
) => {
  await service(mediaService, "mediaService.upsertScanned", {
    libraryId: library,
    items: [scanned(path, { kind: "movie", ...title }, null, { title: extras })],
  });
};

const searchPeople = async (
  session: Session,
  profileId: ProfileId,
  name: string,
): Promise<ReadonlyArray<PersonId>> =>
  (await run(session, "people.search", { profileId, query: `${name} ${TOKEN}` })).map(
    (found) => found.id,
  );

const findPerson = async (
  session: Session,
  profileId: ProfileId,
  name: string,
): Promise<PersonId> => {
  const [found] = await searchPeople(session, profileId, name);

  if (found === undefined) throw new Error(`${name} is not visible to this profile`);

  return found;
};

type ListFilters = Pick<
  CommandArgs<"titles.list">,
  "genre" | "yearFrom" | "yearTo" | "studio" | "minRating"
>;

const filteredPages = async (
  session: Session,
  profileId: ProfileId,
  sort: "name" | "added" | "year",
  filters: ListFilters & { readonly libraryId?: LibraryId },
): Promise<ReadonlyArray<ReadonlyArray<string>>> => {
  const read = async (
    cursor: string | null,
    found: ReadonlyArray<ReadonlyArray<string>>,
  ): Promise<ReadonlyArray<ReadonlyArray<string>>> => {
    const args = { profileId, kind: "movie" as const, sort, limit: 2, ...filters };
    const page = await run(session, "titles.list", cursor === null ? args : { ...args, cursor });
    const all = [...found, page.items.map((title) => title.name)];

    return page.nextCursor === null || all.length > 20 ? all : read(page.nextCursor, all);
  };

  return read(null, []);
};

const filmPath = (edition: string): string =>
  `/stack-${id}/open/versions/Versions {edition-${edition}}.mkv`;

const genreNames = (...letters: ReadonlyArray<string>): ReadonlyArray<string> =>
  letters.map((letter) => `Genre ${letter} ${TOKEN}`);

describe.skipIf(stack === undefined)("against a real stack", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await setUp();
  }, 120_000);

  describe("password accounts", () => {
    it("makes exactly one of two racing first sign-ups the owner", async () => {
      const viewer = await run(fixture.owner, "account.viewer", {});

      expect(viewer.user.role).toBe("owner");
      expect(viewer.sessionKind).toBe("password");
      expect(viewer.scopes).toEqual(
        expect.arrayContaining(["read", "play", "account", "manage", "admin"]),
      );

      if (fixture.race !== null)
        expect([...fixture.race].toSorted()).toStrictEqual(["forbidden", "succeeded"]);
    });

    it("signs in with the right password only", async () => {
      expect(await outcome(signIn(url, password(fixture.memberEmail, "signIn")))).toBe("succeeded");

      const wrong = {
        provider: "password",
        params: { flow: "signIn", email: fixture.memberEmail, password: "nope-nope-nope" },
      } as const;

      expect(await outcome(signIn(url, wrong))).toBe("unauthenticated");
    });

    it("refuses sign-ups without an invite", async () => {
      expect(await outcome(signIn(url, password(`stranger-${id}@movies.test`, "signUp")))).toBe(
        "forbidden",
      );
    });

    it("accepts an invite once and gives the new account the invite's role and a profile", async () => {
      const created = await run(fixture.owner, "invites.create", { role: "member" });

      expect(await run(anonymous(url), "invites.lookup", { code: created.code })).toMatchObject({
        state: "open",
      });
      const guest = await signIn(url, password(`guest-${id}@movies.test`, "signUp", created.code));
      const viewer = await run(guest, "account.viewer", {});

      expect(viewer.user.role).toBe("member");
      expect(viewer.scopes).toStrictEqual(["read", "play", "account"]);
      expect(await run(guest, "profiles.list", {})).toHaveLength(1);
      expect(await run(anonymous(url), "invites.lookup", { code: created.code })).toMatchObject({
        state: "used",
      });
      expect(
        await outcome(signIn(url, password(`again-${id}@movies.test`, "signUp", created.code))),
      ).toBe("conflict");
    });

    it("changes the password only with the current one and signs out other sessions", async () => {
      const email = `changer-${id}@movies.test`;
      const invite = await run(fixture.owner, "invites.create", { email, role: "member" });
      const phone = await signIn(url, password(email, "signUp", invite.code));
      const laptop = await signIn(url, password(email, "signIn"));
      const next = `${PASSWORD}-next`;

      expect(
        await outcome(
          run(phone, "account.changePassword", { currentPassword: "wrong-one", newPassword: next }),
        ),
      ).toBe("forbidden");
      expect(
        await outcome(
          run(phone, "account.changePassword", { currentPassword: PASSWORD, newPassword: next }),
        ),
      ).toBe("succeeded");

      const withNew = {
        provider: "password",
        params: { flow: "signIn", email, password: next },
      } as const;

      expect(await outcome(signIn(url, password(email, "signIn")))).toBe("unauthenticated");
      expect(await outcome(signIn(url, withNew))).toBe("succeeded");
      expect(await outcome(run(phone, "account.viewer", {}))).toBe("succeeded");
      expect(await outcome(run(laptop, "account.viewer", {}))).toBe("unauthenticated");

      const keySessions = [fixture.readKey, fixture.mediaService];

      expect(
        await Promise.all(
          keySessions.map((keySession) =>
            outcome(
              run(keySession, "account.changePassword", {
                currentPassword: "x",
                newPassword: next,
              }),
            ),
          ),
        ),
      ).toStrictEqual(["forbidden", "forbidden"]);
    });

    it("keeps members out of admin commands", async () => {
      expect(await outcome(run(fixture.member, "users.list", {}))).toBe("forbidden");
      expect(await outcome(run(fixture.member, "libraries.listDetails", {}))).toBe("forbidden");
      expect(await outcome(run(fixture.member, "invites.create", { role: "admin" }))).toBe(
        "forbidden",
      );
    });
  });

  describe("account administration", () => {
    it("strips admin scopes from a demoted admin's keys and ends a disabled account's sessions", async () => {
      const email = `admin-${id}@movies.test`;
      const invite = await run(fixture.owner, "invites.create", { email, role: "admin" });
      const admin = await signIn(url, password(email, "signUp", invite.code));
      const adminId = (await run(admin, "account.viewer", {})).user.id;

      const key = await run(admin, "apiKeys.create", {
        name: `Ops ${id}`,
        scopes: ["read", "admin"],
      });

      const agent = await signIn(url, { provider: "apikey", params: { key: key.secret } });

      expect((await run(agent, "account.viewer", {})).scopes).toStrictEqual(["read", "admin"]);
      await run(fixture.owner, "users.setRole", { userId: adminId, role: "member" });
      expect((await run(agent, "account.viewer", {})).scopes).toStrictEqual(["read"]);
      expect(await outcome(run(agent, "users.list", {}))).toBe("forbidden");

      await run(fixture.owner, "users.disable", { userId: adminId });
      expect(await outcome(run(admin, "account.viewer", {}))).toBe("unauthenticated");
      expect(await outcome(run(agent, "account.viewer", {}))).toBe("unauthenticated");
      expect(await outcome(signIn(url, password(email, "signIn")))).toBe("unauthenticated");
      expect(await trySignIn(url, { provider: "apikey", params: { key: key.secret } })).toBeNull();

      await run(fixture.owner, "users.enable", { userId: adminId });
      expect(await outcome(signIn(url, password(email, "signIn")))).toBe("succeeded");
      const ownerId = (await run(fixture.owner, "account.viewer", {})).user.id;
      expect(await outcome(run(fixture.owner, "users.disable", { userId: ownerId }))).toBe(
        "forbidden",
      );
    });
  });

  describe("API keys", () => {
    it("shows a key once, scopes its sessions, and ends them on revocation", async () => {
      const created = await run(fixture.member, "apiKeys.create", {
        name: `Agent ${id}`,
        scopes: ["read"],
      });

      expect(created.secret.startsWith(created.apiKey.prefix)).toBe(true);
      const listed = await run(fixture.member, "apiKeys.list", {});

      expect(JSON.stringify(listed)).not.toContain(created.secret);

      const agent = await signIn(url, { provider: "apikey", params: { key: created.secret } });
      const viewer = await run(agent, "account.viewer", {});

      expect(viewer.sessionKind).toBe("apikey");
      expect(viewer.scopes).toStrictEqual(["read"]);
      expect(await outcome(run(agent, "titles.home", { profileId: fixture.memberProfile }))).toBe(
        "succeeded",
      );

      expect(
        await outcome(
          run(agent, "myList.add", {
            profileId: fixture.memberProfile,
            titleId: fixture.titles.allAges,
          }),
        ),
      ).toBe("forbidden");

      expect(
        await outcome(run(agent, "apiKeys.create", { name: "escalate", scopes: ["read", "play"] })),
      ).toBe("forbidden");

      await run(fixture.member, "apiKeys.revoke", { apiKeyId: created.apiKey.id });

      expect(await outcome(run(agent, "titles.home", { profileId: fixture.memberProfile }))).toBe(
        "unauthenticated",
      );
      expect(
        await trySignIn(url, { provider: "apikey", params: { key: created.secret } }),
      ).toBeNull();
    });

    it("never grants more than the creating session holds", async () => {
      expect(
        await outcome(
          run(fixture.member, "apiKeys.create", { name: "too much", scopes: ["admin"] }),
        ),
      ).toBe("forbidden");

      expect(
        await trySignIn(url, {
          provider: "apikey",
          params: { key: `mk_unknown_${id}_${"x".repeat(32)}` },
        }),
      ).toBeNull();
    });
  });

  describe("device sign-in", () => {
    it("approves a code once and binds the device session to the chosen scopes", async () => {
      const request = await run(anonymous(url), "deviceAuth.request", { clientName: `TV ${id}` });

      expect(
        await run(anonymous(url), "deviceAuth.status", { deviceCode: request.deviceCode }),
      ).toStrictEqual({ state: "pending" });

      expect(
        await trySignIn(url, { provider: "device", params: { deviceCode: request.deviceCode } }),
      ).toBeNull();

      const lookup = await run(fixture.member, "deviceAuth.lookup", {
        userCode: request.userCode.toLowerCase(),
      });

      expect(lookup.clientName).toBe(`TV ${id}`);
      await run(fixture.member, "deviceAuth.approve", {
        userCode: request.userCode,
        scopes: ["read", "play"],
      });

      expect(
        await run(anonymous(url), "deviceAuth.status", { deviceCode: request.deviceCode }),
      ).toStrictEqual({ state: "approved" });

      const tv = await signIn(url, {
        provider: "device",
        params: { deviceCode: request.deviceCode },
      });

      const viewer = await run(tv, "account.viewer", {});

      expect(viewer.sessionKind).toBe("device");
      expect(viewer.scopes).toStrictEqual(["read", "play"]);
      expect(await outcome(run(tv, "apiKeys.list", {}))).toBe("forbidden");
      expect(
        await trySignIn(url, { provider: "device", params: { deviceCode: request.deviceCode } }),
      ).toBeNull();
      expect(
        await run(anonymous(url), "deviceAuth.status", { deviceCode: request.deviceCode }),
      ).toStrictEqual({ state: "consumed" });

      const sessions = await run(fixture.member, "sessions.list", {});
      const deviceSession = sessions.find((session) => session.id === viewer.sessionId);

      expect(deviceSession).toMatchObject({ kind: "device", label: `TV ${id}`, current: false });
      await run(fixture.member, "sessions.revoke", { sessionId: viewer.sessionId });
      expect(await outcome(run(tv, "account.viewer", {}))).toBe("unauthenticated");
    });

    it("refuses denied codes and codes past their ten minutes", async () => {
      const denied = await run(anonymous(url), "deviceAuth.request", {
        clientName: `Denied ${id}`,
      });

      await run(fixture.member, "deviceAuth.deny", { userCode: denied.userCode });

      expect(
        await trySignIn(url, { provider: "device", params: { deviceCode: denied.deviceCode } }),
      ).toBeNull();
      expect(
        await outcome(
          run(fixture.member, "deviceAuth.approve", {
            userCode: denied.userCode,
            scopes: ["read"],
          }),
        ),
      ).toBe("conflict");

      const viewer = await run(fixture.member, "account.viewer", {});
      const deviceCode = `expired-device-code-${id}`;

      const userCode = `ZZZZ-${id
        .toUpperCase()
        .replaceAll(/[^A-Z]/gu, "B")
        .padEnd(4, "B")
        .slice(0, 4)}`;

      const hash = Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceCode)),
      ).toString("hex");

      importDocuments("deviceCodes", [
        JSON.stringify({
          deviceCodeHash: hash,
          userCode,
          clientName: `Old ${id}`,
          status: "approved",
          expiresAt: Date.now() - 1_000,
          decidedBy: viewer.user.id,
          scopes: ["read"],
        }),
      ]);

      expect(await run(anonymous(url), "deviceAuth.status", { deviceCode })).toStrictEqual({
        state: "expired",
      });
      expect(await trySignIn(url, { provider: "device", params: { deviceCode } })).toBeNull();
    });
  });

  describe("the media service", () => {
    it("signs in with only the media-service scope", async () => {
      const viewer = await run(fixture.mediaService, "account.viewer", {});

      expect(viewer.user.role).toBe("service");
      expect(viewer.scopes).toStrictEqual(["media-service"]);
      expect(await outcome(run(fixture.mediaService, "profiles.list", {}))).toBe("forbidden");
      expect(await outcome(run(fixture.mediaService, "users.list", {}))).toBe("forbidden");
      expect(await outcome(run(fixture.mediaService, "libraries.listDetails", {}))).toBe(
        "forbidden",
      );
    });

    it("is the only caller of media service functions", async () => {
      expect(await outcome(service(fixture.owner, "mediaService.pendingJobs", {}))).toBe(
        "forbidden",
      );
      expect(await outcome(service(fixture.member, "mediaService.libraries", {}))).toBe(
        "forbidden",
      );
      expect(await outcome(service(anonymous(url), "mediaService.libraries", {}))).toBe(
        "unauthenticated",
      );
    });

    it("claims, renews, and completes a scan job under a lease", async () => {
      const { jobId } = await run(fixture.owner, "libraries.scan", {
        libraryId: fixture.openLibrary,
        mode: "full",
      });

      const pending = await service(fixture.mediaService, "mediaService.pendingJobs", {});

      expect(pending.map((job) => job.id)).toContain(jobId);

      const claim = await service(fixture.mediaService, "mediaService.claimJob", {
        jobId,
        workerId: `worker-${id}`,
        leaseMs: 60_000,
      });

      expect(claim?.library?.roots).toStrictEqual([`/stack-${id}/open`]);
      expect(
        await service(fixture.mediaService, "mediaService.claimJob", {
          jobId,
          workerId: "other",
          leaseMs: 60_000,
        }),
      ).toBeNull();

      expect(
        await outcome(
          service(fixture.mediaService, "mediaService.renewLease", {
            jobId,
            workerId: "other",
            leaseMs: 60_000,
          }),
        ),
      ).toBe("conflict");

      const renewed = await service(fixture.mediaService, "mediaService.renewLease", {
        jobId,
        workerId: `worker-${id}`,
        leaseMs: 60_000,
        progress: { done: 3, total: 5, message: null },
      });

      expect(renewed.cancelled).toBe(false);
      await service(fixture.mediaService, "mediaService.completeJob", {
        jobId,
        workerId: `worker-${id}`,
      });
      expect(await run(fixture.owner, "jobs.get", { jobId })).toMatchObject({
        status: "succeeded",
        progress: { done: 3 },
      });

      const scans = await run(fixture.owner, "jobs.list", {
        libraryId: fixture.openLibrary,
        limit: 5,
      });

      expect(scans[0]?.id).toBe(jobId);
      expect(
        (
          await run(fixture.owner, "jobs.list", {
            libraryId: fixture.openLibrary,
            status: "succeeded",
            limit: 5,
          })
        ).map((job) => job.id),
      ).toContain(jobId);
      expect(
        scans.every(
          (job) => job.payload.kind === "scan" && job.payload.libraryId === fixture.openLibrary,
        ),
      ).toBe(true);
    });

    it("adds migrated libraries only for absolute folders nobody else owns", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const { jobId, worker } = await claimMigration(fixture, owner, `server-libraries-${id}`);

      const ensure = (roots: ReadonlyArray<string>) =>
        service(fixture.mediaService, "migrationService.ensureLibrary", {
          jobId,
          workerId: worker,
          name: "Imported",
          kind: "movies",
          roots,
        });

      expect(await outcome(ensure([`/stack-${id}/x/../open`]))).toBe("invalid_args");
      expect(await ensure([`/stack-${id}/open/`])).toStrictEqual({
        libraryIds: [fixture.openLibrary],
        created: false,
      });
      expect(await ensure([`/stack-${id}/open/nested`])).toStrictEqual({
        libraryIds: [fixture.openLibrary],
        created: false,
      });
      expect((await ensure([`/stack-${id}/imported`])).created).toBe(true);
      expect((await ensure([`/stack-${id}/imported`])).created).toBe(false);

      expect(
        await outcome(
          service(fixture.mediaService, "migrationService.start", {
            requestedBy: (await run(fixture.member, "account.viewer", {})).user.id,
            source: "plex",
            serverName: "Plex",
            plan: plan(`server-member-${id}`, []),
          }),
        ),
      ).toBe("forbidden");

      await service(fixture.mediaService, "mediaService.completeJob", { jobId, workerId: worker });
    });

    it("queues scrub thumbnails for new and changed files and records them", async () => {
      const library = await run(fixture.owner, "libraries.create", {
        name: `Thumbnails ${id}`,
        kind: "movies",
        roots: [`/stack-${id}/thumbnails`],
      });

      const name = `Scrubbed thumbs${id}`;
      const path = `/stack-${id}/thumbnails/a.mp4`;
      const original = scanned(path, { kind: "movie", name, ageRating: 0 }, null);

      const changed = scanned(path, { kind: "movie", name, ageRating: 0 }, null, {
        sizeBytes: 2_000_000,
      });

      const upsert = (item: ScannedItem) =>
        service(fixture.mediaService, "mediaService.upsertScanned", {
          libraryId: library.libraryId,
          items: [item],
        });

      const [upserted] = await upsert(original);

      if (upserted === undefined) throw new Error("The scan wrote no file");
      const { fileId } = upserted;

      const fileOf = async () => {
        const title = await titleNamed(fixture.owner, fixture.ownerProfile, name);

        const detail = await run(fixture.owner, "titles.get", {
          profileId: fixture.ownerProfile,
          titleId: title.id,
        });

        return detail.files.find((file) => file.id === fileId);
      };

      const queuedFor = async () =>
        (
          await run(fixture.owner, "jobs.list", {
            kind: "trickplay",
            status: "pending",
            limit: 100,
          })
        )
          .filter((job) => job.payload.kind === "trickplay" && job.payload.fileId === fileId)
          .map((job) => job.id);

      const [jobId] = await queuedFor();

      if (jobId === undefined) throw new Error("No trickplay job was queued");

      const stray = await run(fixture.owner, "jobs.list", {
        kind: "trickplay",
        status: "pending",
        limit: 100,
      });

      await Promise.all(
        stray.flatMap((job) =>
          job.id === jobId ? [] : [run(fixture.owner, "jobs.cancel", { jobId: job.id })],
        ),
      );
      expect((await fileOf())?.trickplay).toBeNull();
      expect(
        (await service(fixture.mediaService, "mediaService.pendingJobs", {})).map((job) => job.id),
      ).toContain(jobId);

      await upsert(original);
      expect(await queuedFor()).toStrictEqual([jobId]);

      const worker = `thumbnailer-${id}`;

      const manifest = {
        version: "lfls-pbf7ksg0",
        intervalMs: 10_000,
        tileWidth: 320,
        tileHeight: 180,
        columns: 10,
        rows: 10,
        thumbnailCount: 60,
        sheetCount: 1,
      };

      await service(fixture.mediaService, "mediaService.claimJob", {
        jobId,
        workerId: worker,
        leaseMs: 60_000,
      });
      await service(fixture.mediaService, "mediaService.recordTrickplay", {
        jobId,
        workerId: worker,
        fileId,
        sizeBytes: Bytes.make(1_000_000),
        mtimeMs: EpochMillis.make(1_760_000_000_000),
        manifest,
      });
      await service(fixture.mediaService, "mediaService.completeJob", { jobId, workerId: worker });

      expect((await fileOf())?.trickplay).toStrictEqual(manifest);
      expect(
        await service(fixture.mediaService, "mediaService.trickplayVersions", {
          fileIds: [fileId, "not-a-file"],
        }),
      ).toStrictEqual([
        { fileId, version: manifest.version },
        { fileId: "not-a-file", version: null },
      ]);
      await upsert(original);
      expect(await queuedFor()).toStrictEqual([]);

      await upsert(changed);
      const [again] = await queuedFor();

      if (again === undefined) throw new Error("The changed file was not queued again");
      expect((await fileOf())?.trickplay).toBeNull();

      await service(fixture.mediaService, "mediaService.claimJob", {
        jobId: again,
        workerId: worker,
        leaseMs: 60_000,
      });
      await service(fixture.mediaService, "mediaService.failJob", {
        jobId: again,
        workerId: worker,
        error: "ffmpeg could not read the file",
        retry: false,
      });
      await upsert(changed);
      expect(await queuedFor()).toStrictEqual([]);

      await run(fixture.owner, "libraries.generateTrickplay", { libraryId: library.libraryId });
      await expect.poll(queuedFor, { timeout: 10_000 }).toHaveLength(1);

      await service(fixture.mediaService, "mediaService.markMissing", {
        libraryId: library.libraryId,
        paths: [original.file.path],
      });
      expect(
        await service(fixture.mediaService, "mediaService.trickplayVersions", {
          fileIds: [fileId],
        }),
      ).toStrictEqual([{ fileId, version: null }]);

      const off = await run(fixture.owner, "libraries.update", {
        libraryId: library.libraryId,
        trickplay: false,
      });

      expect(off.trickplay).toBe(false);

      const [unscrubbed] = await upsert(
        scanned(
          `/stack-${id}/thumbnails/b.mp4`,
          { kind: "movie", name: `Unscrubbed thumbs${id}`, ageRating: 0 },
          null,
        ),
      );

      const pending = await run(fixture.owner, "jobs.list", {
        kind: "trickplay",
        status: "pending",
        limit: 100,
      });

      expect(unscrubbed).toBeDefined();
      expect(
        pending.filter(
          (job) => job.payload.kind === "trickplay" && job.payload.fileId === unscrubbed?.fileId,
        ),
      ).toStrictEqual([]);
    });

    it("replaces thumbnail jobs for old contents and cancels the ones nobody needs", async () => {
      const library = await run(fixture.owner, "libraries.create", {
        name: `Thumbnail jobs ${id}`,
        kind: "movies",
        roots: [`/stack-${id}/thumbnail-jobs`],
      });

      const item = (name: string, sizeBytes = 1_000_000) =>
        scanned(
          `/stack-${id}/thumbnail-jobs/${name}.mp4`,
          { kind: "movie", name: `${name} jobs${id}`, ageRating: 0 },
          null,
          { sizeBytes },
        );

      const upsert = async (scannedItem: ScannedItem) => {
        const [upserted] = await service(fixture.mediaService, "mediaService.upsertScanned", {
          libraryId: library.libraryId,
          items: [scannedItem],
        });

        if (upserted === undefined) throw new Error("The scan wrote no file");

        return upserted.fileId;
      };

      const jobsOf = async (fileId: string) =>
        (await run(fixture.owner, "jobs.list", { kind: "trickplay", limit: 100 }))
          .filter((job) => job.payload.kind === "trickplay" && job.payload.fileId === fileId)
          .map((job) => job.status);

      const changing = await upsert(item("Changing"));

      await upsert(item("Changing", 2_000_000));
      expect((await jobsOf(changing)).toSorted()).toStrictEqual(["cancelled", "pending"]);

      await service(fixture.mediaService, "mediaService.markMissing", {
        libraryId: library.libraryId,
        paths: [item("Changing").file.path],
      });
      expect(await jobsOf(changing)).toStrictEqual(["cancelled", "cancelled"]);

      const queued = await upsert(item("Queued"));

      await run(fixture.owner, "libraries.update", {
        libraryId: library.libraryId,
        trickplay: false,
      });
      await expect.poll(() => jobsOf(queued), { timeout: 10_000 }).toStrictEqual(["cancelled"]);

      await run(fixture.owner, "libraries.update", {
        libraryId: library.libraryId,
        trickplay: true,
      });
      const raced = await upsert(item("Raced"));

      const racedJob = (
        await run(fixture.owner, "jobs.list", { kind: "trickplay", status: "pending", limit: 100 })
      ).find((job) => job.payload.kind === "trickplay" && job.payload.fileId === raced);

      if (racedJob === undefined) throw new Error("No job was queued for the raced file");
      const worker = `racer-${id}`;

      const manifest = {
        version: "abc-def",
        intervalMs: 10_000,
        tileWidth: 320,
        tileHeight: 180,
        columns: 10,
        rows: 10,
        thumbnailCount: 60,
        sheetCount: 1,
      };

      await service(fixture.mediaService, "mediaService.claimJob", {
        jobId: racedJob.id,
        workerId: worker,
        leaseMs: 60_000,
      });
      await service(fixture.mediaService, "mediaService.recordTrickplay", {
        jobId: racedJob.id,
        workerId: worker,
        fileId: raced,
        sizeBytes: Bytes.make(3_000_000),
        mtimeMs: EpochMillis.make(1_760_000_000_000),
        manifest,
      });
      expect(
        await service(fixture.mediaService, "mediaService.trickplayVersions", { fileIds: [raced] }),
      ).toStrictEqual([{ fileId: raced, version: null }]);
      await service(fixture.mediaService, "mediaService.completeJob", {
        jobId: racedJob.id,
        workerId: worker,
      });

      const redone = await upsert(item("Raced"));

      const redoneJob = (
        await run(fixture.owner, "jobs.list", { kind: "trickplay", status: "pending", limit: 100 })
      ).find((job) => job.payload.kind === "trickplay" && job.payload.fileId === redone);

      if (redoneJob === undefined) throw new Error("The raced file was not queued again");
      await service(fixture.mediaService, "mediaService.claimJob", {
        jobId: redoneJob.id,
        workerId: worker,
        leaseMs: 60_000,
      });
      await service(fixture.mediaService, "mediaService.recordTrickplay", {
        jobId: redoneJob.id,
        workerId: worker,
        fileId: redone,
        sizeBytes: Bytes.make(1_000_000),
        mtimeMs: EpochMillis.make(1_760_000_000_000),
        manifest,
      });
      await service(fixture.mediaService, "mediaService.completeJob", {
        jobId: redoneJob.id,
        workerId: worker,
      });
      expect(
        await service(fixture.mediaService, "mediaService.trickplayVersions", {
          fileIds: [redone],
        }),
      ).toStrictEqual([{ fileId: redone, version: "abc-def" }]);

      await run(fixture.owner, "libraries.update", {
        libraryId: library.libraryId,
        trickplay: false,
      });
      await upsert(item("Raced", 4_000_000));
      expect(
        await service(fixture.mediaService, "mediaService.trickplayVersions", {
          fileIds: [redone],
        }),
      ).toStrictEqual([{ fileId: redone, version: null }]);

      await run(fixture.owner, "libraries.update", {
        libraryId: library.libraryId,
        trickplay: true,
      });
      const removed = await upsert(item("Removed"));

      expect(await jobsOf(removed)).toStrictEqual(["pending"]);
      await run(fixture.owner, "libraries.remove", { libraryId: library.libraryId });
      await expect.poll(() => jobsOf(removed), { timeout: 10_000 }).toStrictEqual(["cancelled"]);
    });

    it("refuses files outside the library's folders", async () => {
      expect(
        await outcome(
          service(fixture.mediaService, "mediaService.upsertScanned", {
            libraryId: fixture.openLibrary,
            items: [
              scanned("/etc/passwd.mp4", { kind: "movie", name: "Escape", ageRating: 0 }, null),
            ],
          }),
        ),
      ).toBe("invalid_args");

      const climb = `/stack-${id}/open/../../etc/x.mp4`;

      expect(
        await outcome(
          service(fixture.mediaService, "mediaService.upsertScanned", {
            libraryId: fixture.openLibrary,
            items: [scanned(climb, { kind: "movie", name: "Climb", ageRating: 0 }, null)],
          }),
        ),
      ).toBe("invalid_args");
    });
  });

  describe("migration imports", () => {
    it("lists files with their titles and episodes for matching", async () => {
      const episode = await fileAt(fixture, `/stack-${id}/open/show/s01e02.mp4`);

      expect(episode).toMatchObject({
        titleId: fixture.titles.show,
        kind: "show",
        seasonNumber: 1,
        episodeNumber: 2,
        missing: false,
      });
      expect(episode.episodeId).not.toBeNull();
    });

    it("imports watch state once and keeps newer [movies] progress", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const { jobId, worker } = await claimMigration(fixture, owner, `server-watch-${id}`);
      const movie = await fileAt(fixture, `/stack-${id}/open/unrated.mp4`);
      const episode = await fileAt(fixture, `/stack-${id}/open/show/s01e01.mp4`);

      const resume = {
        profileId: fixture.ownerProfile,
        titleId: movie.titleId,
        episodeId: null,
        fileId: movie.fileId,
        watched: false,
        positionMs: ms(120_000),
        playCount: 0,
        lastPlayedAt: at(5_000),
        favorite: true,
      };

      const items = [
        resume,
        {
          profileId: fixture.ownerProfile,
          titleId: episode.titleId,
          episodeId: episode.episodeId,
          fileId: episode.fileId,
          watched: true,
          positionMs: ms(0),
          playCount: 3,
          lastPlayedAt: at(4_000),
          favorite: false,
        },
        {
          profileId: fixture.ownerProfile,
          titleId: episode.titleId,
          episodeId: null,
          fileId: null,
          watched: false,
          positionMs: ms(0),
          playCount: 0,
          lastPlayedAt: null,
          favorite: true,
        },
      ];

      const importBatch = (batch: ReadonlyArray<WatchStateImport>) =>
        service(fixture.mediaService, "migrationService.importWatchState", {
          jobId,
          workerId: worker,
          items: batch,
        });

      expect(await importBatch(items)).toStrictEqual({
        watched: 1,
        inProgress: 1,
        playCounts: 1,
        favorites: 2,
        keptLocal: 0,
      });
      expect(await importBatch(items)).toStrictEqual({
        watched: 0,
        inProgress: 0,
        playCounts: 0,
        favorites: 0,
        keptLocal: 0,
      });

      const older = { ...resume, positionMs: ms(30_000), lastPlayedAt: at(1_000) };

      expect((await importBatch([older])).keptLocal).toBe(1);
      expect((await progressOf(fixture, movie.titleId, null))?.positionMs).toBe(120_000);
      expect(await progressOf(fixture, episode.titleId, episode.episodeId)).toMatchObject({
        watched: true,
      });

      const list = await run(fixture.owner, "myList.list", { profileId: fixture.ownerProfile });
      const listed = list.map((title) => title.id);

      expect(listed.filter((titleId) => titleId === movie.titleId)).toHaveLength(1);
      expect(listed).toContain(episode.titleId);

      await service(fixture.mediaService, "mediaService.completeJob", { jobId, workerId: worker });
    });

    it("imports collections and overrides idempotently", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const { jobId, worker } = await claimMigration(fixture, owner, `server-sets-${id}`);
      const lease = { jobId, workerId: worker };

      const collection = {
        sourceKey: `jellyfin:${id}:boxset`,
        name: `Box ${TOKEN}`,
        sortName: null,
        titleIds: [fixture.titles.adult, fixture.titles.allAges, fixture.titles.adult],
      };

      expect(
        await service(fixture.mediaService, "migrationService.importCollections", {
          ...lease,
          items: [collection],
        }),
      ).toStrictEqual({ imported: 1 });
      expect(
        await service(fixture.mediaService, "migrationService.importCollections", {
          ...lease,
          items: [collection],
        }),
      ).toStrictEqual({ imported: 0 });

      const forOwner = await run(fixture.owner, "collections.list", {
        profileId: fixture.ownerProfile,
      });

      const box = forOwner.find((entry) => entry.name === `Box ${TOKEN}`);

      expect(box?.titles.map((title) => title.id)).toStrictEqual([
        fixture.titles.adult,
        fixture.titles.allAges,
      ]);

      const forKids = await run(fixture.member, "collections.list", {
        profileId: fixture.kidsProfile,
      });

      expect(
        forKids.find((entry) => entry.name === `Box ${TOKEN}`)?.titles.map((title) => title.id),
      ).toStrictEqual([fixture.titles.allAges]);

      const override = {
        titleId: fixture.titles.allAges,
        overrides: { sortName: `Aaa ${TOKEN}` },
      };

      expect(
        await service(fixture.mediaService, "migrationService.importOverrides", {
          ...lease,
          items: [override],
        }),
      ).toStrictEqual({ imported: 1 });
      expect(
        await service(fixture.mediaService, "migrationService.importOverrides", {
          ...lease,
          items: [{ ...override, overrides: { sortName: "Zzz" } }],
        }),
      ).toStrictEqual({ imported: 0 });

      const unboundedYear = 2001.5;

      await direct(fixture.mediaService, "mutation", "migrationService:importOverrides", {
        ...lease,
        items: [
          {
            titleId: fixture.titles.adult,
            overrides: { overview: `Imported ${id}`, year: unboundedYear },
          },
        ],
      });

      expect(
        await run(fixture.owner, "titles.get", {
          profileId: fixture.ownerProfile,
          titleId: fixture.titles.adult,
        }),
      ).toMatchObject({ overview: `Imported ${id}`, year: 2024 });

      await service(fixture.mediaService, "mediaService.completeJob", lease);
    });

    it("reports checkpoints, runs one migration per server, and stops cancelled jobs", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const serverId = `server-status-${id}`;
      const { jobId, worker } = await claimMigration(fixture, owner, serverId);

      const again = await service(fixture.mediaService, "migrationService.start", {
        requestedBy: owner,
        source: "jellyfin",
        serverName: "Jellyfin",
        plan: plan(serverId, []),
      });

      expect(again.jobId).toBe(jobId);

      const state = await service(fixture.mediaService, "migrationService.state", {
        jobId,
        workerId: worker,
      });

      expect(state.checkpoint).toStrictEqual({ phase: "libraries", unit: 0, cursor: 0 });
      expect(
        await outcome(
          service(fixture.mediaService, "migrationService.state", { jobId, workerId: "other" }),
        ),
      ).toBe("conflict");

      const imported = { ...state.imported, watched: 4 };

      expect(
        await service(fixture.mediaService, "migrationService.saveCheckpoint", {
          jobId,
          workerId: worker,
          checkpoint: { phase: "watchState", unit: 1, cursor: 100 },
          imported,
          progress: { done: 100, total: 300, message: "Importing watch history" },
        }),
      ).toStrictEqual({ cancelled: false });

      const runs = await run(fixture.owner, "migration.status", {});
      const current = runs.find((entry) => entry.job.id === jobId);

      expect(current).toMatchObject({
        phase: "watchState",
        imported: { watched: 4 },
        job: { status: "running", progress: { done: 100, total: 300 } },
      });

      await run(fixture.owner, "jobs.cancel", { jobId });
      expect(
        await service(fixture.mediaService, "migrationService.saveCheckpoint", {
          jobId,
          workerId: worker,
          checkpoint: { phase: "watchState", unit: 1, cursor: 200 },
          imported,
          progress: { done: 200, total: 300, message: null },
        }),
      ).toStrictEqual({ cancelled: true });
    });
  });

  describe("profiles", () => {
    it("keeps profiles to their account", async () => {
      expect(
        await outcome(run(fixture.owner, "titles.home", { profileId: fixture.memberProfile })),
      ).toBe("not_found");
    });

    it("locks a PIN profile on other sessions until the PIN is entered", async () => {
      const profile = await run(fixture.member, "profiles.create", {
        name: `Private ${id}`,
        avatar: "owl",
        kids: false,
      });

      await run(fixture.member, "profiles.setPin", { profileId: profile.id, pin: "4821" });
      expect(await outcome(run(fixture.member, "titles.home", { profileId: profile.id }))).toBe(
        "succeeded",
      );

      const other = await signIn(url, password(fixture.memberEmail, "signIn"));

      const listed = (await run(other, "profiles.list", {})).find(
        (candidate) => candidate.id === profile.id,
      );

      expect(listed).toMatchObject({ hasPin: true, locked: true });
      expect(await outcome(run(other, "titles.home", { profileId: profile.id }))).toBe("forbidden");
      expect(
        await outcome(run(other, "profiles.setPin", { profileId: profile.id, pin: null })),
      ).toBe("forbidden");
      expect(
        await run(other, "profiles.unlock", { profileId: profile.id, pin: "0000" }),
      ).toStrictEqual({ status: "wrong_pin", attemptsLeft: 4 });
      expect(
        await run(other, "profiles.unlock", { profileId: profile.id, pin: "4821" }),
      ).toStrictEqual({ status: "unlocked" });
      expect(await outcome(run(other, "titles.home", { profileId: profile.id }))).toBe("succeeded");
      await run(other, "profiles.lock", { profileId: profile.id });
      expect(await outcome(run(other, "titles.home", { profileId: profile.id }))).toBe("forbidden");
    });

    it("keeps a kids profile from lifting its limits once every adult profile has a PIN", async () => {
      const email = `parent-${id}@movies.test`;
      const parent = await inviteMember(fixture.owner, email);
      const adult = await firstProfile(parent);

      const kids = await run(parent, "profiles.create", {
        name: `Little ${id}`,
        avatar: "fox",
        kids: true,
      });

      expect((await run(parent, "account.viewer", {})).scopes).toContain("account");
      await run(parent, "profiles.setPin", { profileId: adult, pin: "2468" });

      expect((await run(parent, "account.viewer", {})).scopes).toContain("account");
      const shared = await signIn(url, password(email, "signIn"));

      expect((await run(shared, "account.viewer", {})).scopes).toStrictEqual(["read", "play"]);
      expect(
        await outcome(
          run(shared, "profiles.update", { profileId: kids.id, kids: false, maxAgeRating: null }),
        ),
      ).toBe("forbidden");
      expect(
        await outcome(
          run(shared, "profiles.create", { name: `Open ${id}`, avatar: "owl", kids: false }),
        ),
      ).toBe("forbidden");
      expect(
        await outcome(run(shared, "apiKeys.create", { name: `Key ${id}`, scopes: ["read"] })),
      ).toBe("forbidden");
      expect(await outcome(run(shared, "titles.home", { profileId: kids.id }))).toBe("succeeded");

      await run(shared, "profiles.unlock", { profileId: adult, pin: "2468" });
      expect((await run(shared, "account.viewer", {})).scopes).toContain("account");
      await run(shared, "profiles.lock", { profileId: adult });
      expect((await run(shared, "account.viewer", {})).scopes).not.toContain("account");
    });

    it("hides titles above a kids profile's age, and unrated ones, without saying so", async () => {
      const seen = await run(fixture.member, "titles.search", {
        profileId: fixture.kidsProfile,
        query: TOKEN,
        limit: 50,
      });

      expect(seen.map((title) => title.name).toSorted()).toStrictEqual([
        `All Ages ${TOKEN}`,
        `Show ${TOKEN}`,
      ]);
      expect(
        await outcome(
          run(fixture.member, "titles.get", {
            profileId: fixture.kidsProfile,
            titleId: fixture.titles.adult,
          }),
        ),
      ).toBe("not_found");

      const adultSeen = await run(fixture.member, "titles.search", {
        profileId: fixture.memberProfile,
        query: TOKEN,
        limit: 50,
      });

      expect(adultSeen.map((title) => title.name)).toEqual(
        expect.arrayContaining([`Adult ${TOKEN}`, `Unrated ${TOKEN}`]),
      );
    });
  });

  describe("library access", () => {
    it("shows restricted libraries to members only once granted", async () => {
      const titleArgs = { profileId: fixture.memberProfile, titleId: fixture.titles.hidden };

      expect(await outcome(run(fixture.member, "titles.get", titleArgs))).toBe("not_found");
      await run(fixture.owner, "users.setLibraryAccess", {
        userId: (await run(fixture.member, "account.viewer", {})).user.id,
        libraryIds: [fixture.restrictedLibrary],
      });
      expect(await outcome(run(fixture.member, "titles.get", titleArgs))).toBe("succeeded");
      expect(
        (await run(fixture.member, "libraries.list", {})).map((library) => library.id),
      ).toContain(fixture.restrictedLibrary);
    });
  });

  describe("playback", () => {
    it("signs a playback token in Convex that the contracts verifier accepts", async () => {
      const started = await run(fixture.member, "playback.createSession", {
        profileId: fixture.memberProfile,
        deviceId: device("laptop"),
        titleId: fixture.titles.allAges,
      });

      expect(started.tokenExpiresAt - Date.now()).toBeGreaterThan(
        PLAYBACK_TOKEN_LIFETIME_MS - 60_000,
      );
      const secret = Redacted.make(stack?.playbackTokenSecret ?? "");

      const payload = await Effect.runPromise(
        Effect.flatMap(importPlaybackTokenSecret(secret), (key) =>
          verifyPlaybackToken(key, started.token),
        ),
      );

      expect(payload).toMatchObject({
        aud: "media",
        pid: fixture.memberProfile,
        fid: started.file.id,
        sid: started.sessionId,
      });
      expect(payload.exp - payload.iat).toBe(PLAYBACK_TOKEN_LIFETIME_MS);

      const resolved = await service(fixture.mediaService, "mediaService.resolveFile", {
        fileId: started.file.id,
      });

      expect(resolved.path).toBe(`/stack-${id}/open/all-ages.mp4`);
      expect(resolved.roots).toStrictEqual([`/stack-${id}/open`]);
    });

    it("answers no session for an ID that names none, so the media service counts it ended", async () => {
      expect(
        await service(fixture.mediaService, "mediaService.sessionStatus", {
          sessionId: "not-a-playback-session",
        }),
      ).toBeNull();
    });

    it("ends a session's playback when it signs out", async () => {
      const laptop = await signIn(url, password(fixture.memberEmail, "signIn"));

      const started = await run(laptop, "playback.createSession", {
        profileId: fixture.memberProfile,
        deviceId: device("signout"),
        titleId: fixture.titles.allAges,
      });

      await laptop.client.action(makeFunctionReference<"action">("auth:signOut"), {});

      expect(
        await service(fixture.mediaService, "mediaService.sessionStatus", {
          sessionId: started.sessionId,
        }),
      ).toMatchObject({ status: "ended" });
      expect(await outcome(run(laptop, "account.viewer", {}))).toBe("unauthenticated");
    });

    it("keeps an account to eight playing devices, ending the quietest", async () => {
      await Promise.all(
        (await run(fixture.member, "playback.active", {})).map((session) =>
          run(fixture.member, "playback.endSession", { sessionId: session.id, positionMs: ms(0) }),
        ),
      );

      const devices = Array.from({ length: 9 }, (_, index) => device(`wall-${index}`));

      const started = await devices.reduce<
        Promise<ReadonlyArray<{ sessionId: PlaybackSessionId }>>
      >(
        async (earlier, deviceId) => [
          ...(await earlier),
          await run(fixture.member, "playback.createSession", {
            profileId: fixture.memberProfile,
            deviceId,
            titleId: fixture.titles.allAges,
          }),
        ],
        Promise.resolve([]),
      );

      const statuses = await Promise.all(
        started.map(({ sessionId }) =>
          service(fixture.mediaService, "mediaService.sessionStatus", { sessionId }),
        ),
      );

      expect(statuses.map((status) => status?.status)).toStrictEqual([
        "ended",
        ...Array.from({ length: 8 }, () => "active"),
      ]);

      await Promise.all(
        started.map(({ sessionId }) =>
          run(fixture.member, "playback.endSession", { sessionId, positionMs: ms(0) }),
        ),
      );
    });

    it("ends every playback session of a sign-in it signs out, as the media service sees", async () => {
      const tablet = await signIn(url, password(fixture.memberEmail, "signIn"));

      const started = await Promise.all(
        ["a", "b", "c"].map((name) =>
          run(tablet, "playback.createSession", {
            profileId: fixture.memberProfile,
            deviceId: device(`tablet-${name}`),
            titleId: fixture.titles.allAges,
          }),
        ),
      );

      await tablet.client.action(makeFunctionReference<"action">("auth:signOut"), {});

      const statuses = await Promise.all(
        started.map(({ sessionId }) =>
          service(fixture.mediaService, "mediaService.sessionStatus", { sessionId }),
        ),
      );

      expect(statuses.map((status) => status?.status)).toStrictEqual(["ended", "ended", "ended"]);
    });

    it("ends sessions of separate accounts at once without one end failing another", async () => {
      const viewers = await Array.from(
        { length: 24 },
        (_, index) => `concurrent-end-${index}`,
      ).reduce<
        Promise<ReadonlyArray<{ readonly viewer: Session; readonly sessionId: PlaybackSessionId }>>
      >(async (earlier, name) => {
        const before = await earlier;
        const viewer = await inviteMember(fixture.owner, `${name}-${id}@movies.test`);

        const started = await run(viewer, "playback.createSession", {
          profileId: await firstProfile(viewer),
          deviceId: device(name),
          titleId: fixture.titles.allAges,
        });

        return [...before, { viewer, sessionId: started.sessionId }];
      }, Promise.resolve([]));

      const ends = await Promise.allSettled(
        viewers.map(({ viewer, sessionId }) =>
          run(viewer, "playback.endSession", { sessionId, positionMs: ms(0) }),
        ),
      );

      expect(ends.filter((end) => end.status === "rejected")).toStrictEqual([]);

      const statuses = await Promise.all(
        viewers.map(({ sessionId }) =>
          service(fixture.mediaService, "mediaService.sessionStatus", { sessionId }),
        ),
      );

      expect(statuses.map((status) => status?.status)).toStrictEqual(viewers.map(() => "ended"));
    }, 120_000);

    it("stops renewing a token once the profile may no longer see the title", async () => {
      await run(fixture.owner, "users.setLibraryAccess", {
        userId: (await run(fixture.member, "account.viewer", {})).user.id,
        libraryIds: [fixture.restrictedLibrary],
      });

      const started = await run(fixture.member, "playback.createSession", {
        profileId: fixture.memberProfile,
        deviceId: device("renew"),
        titleId: fixture.titles.hidden,
      });

      expect(
        await outcome(run(fixture.member, "playback.renewToken", { sessionId: started.sessionId })),
      ).toBe("succeeded");
      await run(fixture.owner, "users.setLibraryAccess", {
        userId: (await run(fixture.member, "account.viewer", {})).user.id,
        libraryIds: [],
      });
      expect(
        await outcome(run(fixture.member, "playback.renewToken", { sessionId: started.sessionId })),
      ).toBe("not_found");
      await run(fixture.owner, "users.setLibraryAccess", {
        userId: (await run(fixture.member, "account.viewer", {})).user.id,
        libraryIds: [fixture.restrictedLibrary],
      });
    });

    it("keeps an older session from overwriting a newer one and marks watched at 90%", async () => {
      const base = { profileId: fixture.memberProfile, titleId: fixture.titles.unrated } as const;

      const older = await run(fixture.member, "playback.createSession", {
        ...base,
        deviceId: device("phone"),
      });

      const newer = await run(fixture.member, "playback.createSession", {
        ...base,
        deviceId: device("tv"),
      });

      expect(
        await run(fixture.member, "playback.reportProgress", {
          sessionId: newer.sessionId,
          positionMs: ms(120_000),
          event: "tick",
        }),
      ).toStrictEqual({ applied: true, watched: false });

      const playing = await service(fixture.mediaService, "mediaService.sessionStatus", {
        sessionId: newer.sessionId,
      });

      expect(playing).toStrictEqual({
        sessionId: newer.sessionId,
        status: "active",
        fileId: newer.file.id,
        endedAt: null,
        state: "playing",
        positionMs: 120_000,
      });

      await run(fixture.member, "playback.reportProgress", {
        sessionId: newer.sessionId,
        positionMs: ms(120_000),
        event: "pause",
      });

      const paused = await service(fixture.mediaService, "mediaService.sessionStatus", {
        sessionId: newer.sessionId,
      });

      expect(paused).toStrictEqual({ ...playing, state: "paused" });
      expect(
        await run(fixture.member, "playback.reportProgress", {
          sessionId: older.sessionId,
          positionMs: ms(10_000),
          event: "tick",
        }),
      ).toStrictEqual({ applied: false, watched: false });

      const detail = await run(fixture.member, "titles.get", base);

      expect(detail.progress?.positionMs).toBe(120_000);

      const resume = await run(fixture.member, "history.continueWatching", {
        profileId: fixture.memberProfile,
      });

      expect(resume.map((item) => item.title.id)).toContain(fixture.titles.unrated);
      expect(
        await run(fixture.member, "playback.reportProgress", {
          sessionId: newer.sessionId,
          positionMs: ms(DURATION_MS * 0.91),
          event: "tick",
        }),
      ).toStrictEqual({ applied: true, watched: true });

      await run(fixture.member, "playback.endSession", {
        sessionId: newer.sessionId,
        positionMs: ms(DURATION_MS * 0.91),
      });

      const ended = await service(fixture.mediaService, "mediaService.sessionStatus", {
        sessionId: newer.sessionId,
      });

      expect(ended?.status).toBe("ended");
    });

    it("downloads beside the device's playback, four at a time, until the sign-in ends", async () => {
      const phone = await signIn(url, password(fixture.memberEmail, "signIn"));
      const deviceId = device("downloads");
      const base = { profileId: fixture.memberProfile, deviceId } as const;

      const playing = await run(phone, "playback.createSession", {
        ...base,
        titleId: fixture.titles.allAges,
      });

      const first = await run(phone, "downloads.start", {
        ...base,
        titleId: fixture.titles.allAges,
      });

      const again = await run(phone, "downloads.start", {
        ...base,
        titleId: fixture.titles.allAges,
      });

      const status = (sessionId: PlaybackSessionId) =>
        service(fixture.mediaService, "mediaService.sessionStatus", { sessionId }).then(
          (session) => session?.status,
        );

      expect(await status(playing.sessionId)).toBe("active");
      expect(await status(first.sessionId)).toBe("ended");
      expect(await status(again.sessionId)).toBe("active");
      expect((await run(phone, "playback.active", {})).map((session) => session.id)).not.toContain(
        again.sessionId,
      );

      expect(
        await run(phone, "playback.reportProgress", {
          sessionId: again.sessionId,
          positionMs: ms(5_000),
          event: "tick",
        }),
      ).toStrictEqual({ applied: false, watched: false });
      expect(await outcome(run(phone, "playback.renewToken", { sessionId: again.sessionId }))).toBe(
        "succeeded",
      );
      expect(await outcome(run(phone, "downloads.end", { sessionId: playing.sessionId }))).toBe(
        "invalid_args",
      );

      const episodes = await run(phone, "titles.episodes", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
        seasonNumber: 1,
      });

      const unrated = await run(phone, "downloads.start", {
        ...base,
        titleId: fixture.titles.unrated,
      });

      await run(phone, "downloads.start", { ...base, titleId: fixture.titles.hidden });

      await episodes.slice(0, 2).reduce(async (earlier, episode) => {
        await earlier;
        await run(phone, "downloads.start", {
          ...base,
          titleId: fixture.titles.show,
          episodeId: episode.id,
        });
      }, Promise.resolve());

      expect(episodes).toHaveLength(2);
      expect(await status(again.sessionId)).toBe("ended");
      expect(await status(unrated.sessionId)).toBe("active");
      expect(await status(playing.sessionId)).toBe("active");

      await phone.client.action(makeFunctionReference<"action">("auth:signOut"), {});

      expect(await status(unrated.sessionId)).toBe("ended");
    });

    it("signs download tokens for downloading and keeps eight downloads on the account", async () => {
      const devices = Array.from({ length: 9 }, (_, index) => device(`fleet-${index}`));

      const started = await devices.reduce<
        Promise<Array<{ readonly sessionId: PlaybackSessionId; readonly token: string }>>
      >(
        async (earlier, deviceId) => [
          ...(await earlier),
          await run(fixture.member, "downloads.start", {
            profileId: fixture.memberProfile,
            deviceId,
            titleId: fixture.titles.allAges,
          }),
        ],
        Promise.resolve([]),
      );

      const statuses = await Promise.all(
        started.map(({ sessionId }) =>
          service(fixture.mediaService, "mediaService.sessionStatus", { sessionId }).then(
            (session) => session?.status,
          ),
        ),
      );

      expect(statuses).toStrictEqual(["ended", ...Array.from({ length: 8 }, () => "active")]);

      const secret = Redacted.make(stack?.playbackTokenSecret ?? "");
      const last = started.at(-1);

      const payload = await Effect.runPromise(
        Effect.flatMap(importPlaybackTokenSecret(secret), (key) =>
          verifyPlaybackToken(key, last?.token ?? ""),
        ),
      );

      expect(payload.pur).toBe("download");

      await Promise.all(
        started.map(({ sessionId }) => run(fixture.member, "downloads.end", { sessionId })),
      );
    });

    it("saves offline progress unless the item was played elsewhere since", async () => {
      const base = { profileId: fixture.memberProfile, titleId: fixture.titles.allAges } as const;

      const download = await run(fixture.member, "downloads.start", {
        ...base,
        deviceId: device("offline"),
      });

      await run(fixture.member, "downloads.end", { sessionId: download.sessionId });

      const offline = {
        ...base,
        fileId: download.file.id,
        durationMs: ms(DURATION_MS),
      } as const;

      expect(
        await run(fixture.member, "downloads.recordProgress", {
          ...offline,
          positionMs: ms(DURATION_MS * 0.5),
          playedAt: EpochMillis.make(Date.now()),
          sentAt: EpochMillis.make(Date.now()),
        }),
      ).toStrictEqual({ applied: true, watched: false });
      expect((await run(fixture.member, "titles.get", base)).progress?.positionMs).toBe(
        DURATION_MS * 0.5,
      );

      expect(
        await run(fixture.member, "downloads.recordProgress", {
          ...offline,
          positionMs: ms(DURATION_MS * 0.95),
          playedAt: EpochMillis.make(Date.now() - 60 * 60 * 1000),
          sentAt: EpochMillis.make(Date.now()),
        }),
      ).toStrictEqual({ applied: false, watched: false });
      expect(
        await run(fixture.member, "downloads.recordProgress", {
          ...offline,
          positionMs: ms(DURATION_MS * 0.95),
          playedAt: EpochMillis.make(Date.now()),
          sentAt: EpochMillis.make(Date.now()),
        }),
      ).toStrictEqual({ applied: true, watched: true });

      const hour = 60 * 60 * 1000;

      expect(
        await run(fixture.member, "downloads.recordProgress", {
          ...offline,
          positionMs: ms(DURATION_MS * 0.2),
          playedAt: EpochMillis.make(Date.now() + 2 * hour - hour),
          sentAt: EpochMillis.make(Date.now() + 2 * hour),
        }),
      ).toStrictEqual({ applied: false, watched: true });
      expect(
        await outcome(
          run(fixture.member, "downloads.recordProgress", {
            ...offline,
            titleId: fixture.titles.unrated,
            positionMs: ms(0),
            playedAt: EpochMillis.make(Date.now()),
            sentAt: EpochMillis.make(Date.now()),
          }),
        ),
      ).toBe("not_found");
    });

    it("offers the next episode after a finished one", async () => {
      const show = await run(fixture.member, "titles.get", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
      });

      const first = show.nextEpisode;

      expect(first?.episodeNumber).toBe(1);

      if (first === null) return;

      const started = await run(fixture.member, "playback.createSession", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
        episodeId: first.id,
        deviceId: device("tablet"),
      });

      await run(fixture.member, "playback.reportProgress", {
        sessionId: started.sessionId,
        positionMs: ms(DURATION_MS),
        event: "ended",
      });

      const next = await run(fixture.member, "playback.nextEpisode", {
        profileId: fixture.memberProfile,
        episodeId: first.id,
      });

      expect(next?.episodeNumber).toBe(2);

      const resume = await run(fixture.member, "history.continueWatching", {
        profileId: fixture.memberProfile,
      });

      expect(resume.find((item) => item.title.id === fixture.titles.show)).toMatchObject({
        reason: "next",
        episode: { episodeNumber: 2 },
      });

      const second = {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
        episodeId: next?.id,
      };

      if (second.episodeId === undefined) return;
      await run(fixture.member, "history.markWatched", { ...second, episodeId: second.episodeId });
      expect((await run(fixture.member, "titles.get", second)).nextEpisode).toBeNull();
      await run(fixture.member, "history.markUnwatched", {
        ...second,
        episodeId: second.episodeId,
      });
      expect((await run(fixture.member, "titles.get", second)).nextEpisode?.episodeNumber).toBe(2);
    });
  });

  describe("versions", () => {
    const film = { kind: "movie" as const, name: `Versions ${TOKEN}`, ageRating: 0 };

    const scanFilm = async () => {
      await service(fixture.mediaService, "mediaService.upsertScanned", {
        libraryId: fixture.openLibrary,
        items: [
          scanned(filmPath("Theatrical"), film, null, {
            version: { name: "Theatrical", codec: "h264", width: 1920, height: 1080, hdr: "none" },
          }),
          scanned(filmPath("Director's Cut"), film, null, {
            version: {
              name: "Director's Cut",
              codec: "hevc",
              width: 3840,
              height: 2160,
              hdr: "hdr10",
            },
          }),
          scanned(filmPath("Workprint"), film, null, {
            version: { name: "Workprint", codec: "h264", width: 3840, height: 2160, hdr: "none" },
          }),
        ],
      });
      await service(fixture.mediaService, "mediaService.markMissing", {
        libraryId: fixture.openLibrary,
        paths: [filmPath("Workprint")],
      });

      return (await titleNamed(fixture.member, fixture.memberProfile, film.name)).id;
    };

    it("lists a movie's files on disk best first and plays the one a profile last chose", async () => {
      const titleId = await scanFilm();
      const base = { profileId: fixture.memberProfile, titleId };
      const listed = await run(fixture.member, "titles.versions", base);

      expect(listed.map((version) => [version.versionName, version.height, version.hdr])).toEqual([
        ["Director's Cut", 2160, "hdr10"],
        ["Theatrical", 1080, "none"],
      ]);
      expect(listed.some((version) => version.lastPlayed)).toBe(false);
      expect((await run(fixture.member, "titles.get", base)).versions).toStrictEqual(listed);

      const [best, theatrical] = listed;

      if (best === undefined || theatrical === undefined) return;

      expect(
        (
          await run(fixture.member, "playback.createSession", {
            ...base,
            deviceId: device("versions-tv"),
          })
        ).file.id,
      ).toBe(best.id);

      expect(
        (
          await run(fixture.member, "playback.createSession", {
            ...base,
            deviceId: device("versions-browser"),
            capabilities: {
              containers: ["mp4"],
              videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
              audioCodecs: [{ codec: "aac" }],
              maxWidth: 3840,
              maxHeight: 2160,
              hls: false,
              mse: true,
            },
          })
        ).file.id,
      ).toBe(theatrical.id);

      const chosen = await run(fixture.member, "playback.createSession", {
        ...base,
        deviceId: device("versions-laptop"),
        fileId: theatrical.id,
      });

      expect(chosen.file).toMatchObject({ id: theatrical.id, versionName: "Theatrical" });
      await run(fixture.member, "playback.reportProgress", {
        sessionId: chosen.sessionId,
        positionMs: ms(90_000),
        event: "tick",
      });

      const remembered = await run(fixture.member, "titles.versions", base);

      expect(
        remembered.filter((version) => version.lastPlayed).map((version) => version.id),
      ).toEqual([theatrical.id]);

      const resumed = await run(fixture.member, "playback.createSession", {
        ...base,
        deviceId: device("versions-phone"),
      });

      expect(resumed.file.id).toBe(theatrical.id);
      expect(resumed.resumePositionMs).toBe(90_000);

      const switched = await run(fixture.member, "playback.createSession", {
        ...base,
        deviceId: device("versions-phone"),
        fileId: best.id,
      });

      expect(switched.resumePositionMs).toBe(90_000);

      expect(
        (
          await run(fixture.owner, "titles.versions", {
            profileId: fixture.ownerProfile,
            titleId,
          })
        ).some((version) => version.lastPlayed),
      ).toBe(false);
    });

    it("refuses a version gone from disk or of another title", async () => {
      const titleId = await scanFilm();
      const base = { profileId: fixture.memberProfile, titleId, deviceId: device("versions-odd") };
      const missing = await fileAt(fixture, filmPath("Workprint"));
      const other = await fileAt(fixture, `/stack-${id}/open/all-ages.mp4`);

      expect(
        await outcome(
          run(fixture.member, "playback.createSession", { ...base, fileId: missing.fileId }),
        ),
      ).toBe("conflict");
      expect(
        await outcome(
          run(fixture.member, "playback.createSession", { ...base, fileId: other.fileId }),
        ),
      ).toBe("not_found");
    });

    it("lists an episode's versions and keeps versions behind grants and ratings", async () => {
      const show = { kind: "show" as const, name: `Show ${TOKEN}`, ageRating: 7 };

      await service(fixture.mediaService, "mediaService.upsertScanned", {
        libraryId: fixture.openLibrary,
        items: [
          scanned(
            `/stack-${id}/open/show/s01e01 - 720p.mp4`,
            show,
            { season: 1, episode: 1 },
            {
              version: { name: "720p", codec: "h264", width: 1280, height: 720, hdr: "none" },
            },
          ),
        ],
      });

      const [first] = await run(fixture.member, "titles.episodes", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
        seasonNumber: 1,
      });

      if (first === undefined) throw new Error("The show has no episodes");

      const episode = { profileId: fixture.memberProfile, titleId: fixture.titles.show };

      expect(
        (await run(fixture.member, "titles.versions", { ...episode, episodeId: first.id })).map(
          (version) => [version.versionName, version.height],
        ),
      ).toEqual([
        [null, 1080],
        ["720p", 720],
      ]);
      expect(await outcome(run(fixture.member, "titles.versions", episode))).toBe("invalid_args");

      expect(
        await outcome(
          run(fixture.member, "titles.versions", {
            profileId: fixture.kidsProfile,
            titleId: fixture.titles.adult,
          }),
        ),
      ).toBe("not_found");

      const stranger = await inviteMember(fixture.owner, `versions-${id}@movies.test`);

      expect(
        await outcome(
          run(stranger, "titles.versions", {
            profileId: await firstProfile(stranger),
            titleId: fixture.titles.hidden,
          }),
        ),
      ).toBe("not_found");
    });
  });

  describe("watch rooms", () => {
    it("lets only the host's device control the clock, at the current revision", async () => {
      const hostDevice = device("host");
      const guestDevice = device("guest");

      const room = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: hostDevice,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      expect(room.clock).toMatchObject({ status: "paused", revision: 0 });

      const joined = await run(fixture.member, "rooms.join", {
        roomId: room.id,
        profileId: fixture.memberProfile,
        deviceId: guestDevice,
      });

      expect(joined.members.map((member) => member.role).toSorted()).toStrictEqual([
        "guest",
        "host",
      ]);

      const guestControl = {
        roomId: room.id,
        deviceId: guestDevice,
        revision: 0,
        positionMs: ms(5_000),
      };

      expect(await outcome(run(fixture.member, "rooms.play", guestControl))).toBe("forbidden");
      expect(
        await outcome(
          run(fixture.owner, "rooms.play", { ...guestControl, deviceId: device("other") }),
        ),
      ).toBe("forbidden");

      const playing = await run(fixture.owner, "rooms.play", {
        roomId: room.id,
        deviceId: hostDevice,
        revision: 0,
        positionMs: ms(5_000),
      });

      expect(playing).toMatchObject({ status: "playing", revision: 1, positionAtAnchorMs: 5_000 });
      expect(
        await outcome(
          run(fixture.owner, "rooms.pause", {
            roomId: room.id,
            deviceId: hostDevice,
            revision: 0,
            positionMs: ms(6_000),
          }),
        ),
      ).toBe("stale_revision");

      const guestStream = await run(fixture.member, "playback.createSession", {
        profileId: fixture.memberProfile,
        deviceId: guestDevice,
        titleId: fixture.titles.allAges,
        roomId: room.id,
      });

      expect(guestStream.file.id).toBe(room.fileId);
      await run(fixture.member, "rooms.heartbeat", { roomId: room.id, deviceId: guestDevice });
      await run(fixture.member, "rooms.leave", { roomId: room.id, deviceId: guestDevice });
      expect((await run(fixture.owner, "rooms.get", { roomId: room.id })).clock.status).toBe(
        "playing",
      );
      expect(
        await outcome(run(fixture.member, "rooms.end", { roomId: room.id, deviceId: guestDevice })),
      ).toBe("forbidden");
      await run(fixture.owner, "rooms.end", { roomId: room.id, deviceId: hostDevice });
      expect((await run(fixture.owner, "rooms.get", { roomId: room.id })).clock.status).toBe(
        "ended",
      );
      expect(
        await outcome(
          run(fixture.member, "rooms.join", {
            roomId: room.id,
            profileId: fixture.memberProfile,
            deviceId: guestDevice,
          }),
        ),
      ).toBe("conflict");
    });

    it("re-anchors on a host heartbeat from when the host read its position", async () => {
      const hostDevice = device("host3");

      const room = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: hostDevice,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      const playing = await run(fixture.owner, "rooms.play", {
        roomId: room.id,
        deviceId: hostDevice,
        revision: 0,
        positionMs: ms(5_000),
      });

      const beat = (positionMs: number, atServerTime: number) =>
        run(fixture.owner, "rooms.heartbeat", {
          roomId: room.id,
          deviceId: hostDevice,
          positionMs: ms(positionMs),
          atServerTime: EpochMillis.make(atServerTime),
          revision: playing.revision,
        });

      await sleep(300);
      expect(await beat(5_000, playing.anchorServerTime)).toStrictEqual(playing);

      const anchored = await beat(5_000, playing.anchorServerTime + 200);

      expect(anchored.revision).toBe(playing.revision + 1);
      expect(anchored.positionAtAnchorMs).toBe(
        5_000 + anchored.anchorServerTime - playing.anchorServerTime - 200,
      );

      const live = anchored.positionAtAnchorMs + Date.now() - anchored.anchorServerTime;

      expect(
        await run(fixture.owner, "rooms.heartbeat", {
          roomId: room.id,
          deviceId: hostDevice,
          positionMs: ms(live - 100),
          revision: anchored.revision,
        }),
      ).toStrictEqual(anchored);
      await run(fixture.owner, "rooms.end", { roomId: room.id, deviceId: hostDevice });
    });

    it("keeps the place of members browsing elsewhere, away, past the presence timeouts", async () => {
      const hostDevice = device("browsing-host");
      const awayGuest = device("browsing-guest");
      const silentGuest = device("silent-guest");
      const owner = await run(fixture.owner, "account.viewer", {});
      const member = await run(fixture.member, "account.viewer", {});
      const longAgo = Date.now() - 2 * 60_000;
      const lastHeard = Date.now() - 45_000;

      const room = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: hostDevice,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      const playing = await run(fixture.owner, "rooms.play", {
        roomId: room.id,
        deviceId: hostDevice,
        revision: 0,
        positionMs: ms(5_000),
      });

      const guestRow = (deviceId: DeviceId) =>
        JSON.stringify({
          roomId: room.id,
          userId: member.user.id,
          profileId: fixture.memberProfile,
          deviceId,
          role: "guest",
          joinedAt: lastHeard,
          lastSeenAt: lastHeard,
          presence: "watching",
          driftMs: 2_400,
        });

      importDocuments("roomMembers", [guestRow(awayGuest), guestRow(silentGuest)]);

      importDocuments("rooms", [
        JSON.stringify({
          titleId: fixture.titles.allAges,
          episodeId: null,
          fileId: room.fileId,
          hostUserId: owner.user.id,
          hostProfileId: fixture.ownerProfile,
          hostDeviceId: `quiet-host-${id}`,
          status: "playing",
          positionAtAnchorMs: 0,
          anchorServerTime: longAgo,
          playbackRate: 1,
          revision: 2,
          hostLastSeenAt: longAgo,
          hostAway: false,
        }),
      ]);

      const hostAway = () =>
        run(fixture.owner, "rooms.heartbeat", {
          roomId: room.id,
          deviceId: hostDevice,
          positionMs: ms(0),
          revision: playing.revision,
          presence: "away",
        });

      expect(await hostAway()).toStrictEqual(playing);
      expect((await memberOn(fixture, room.id, hostDevice)).presence).toBe("watching");
      await run(fixture.member, "rooms.heartbeat", {
        roomId: room.id,
        deviceId: awayGuest,
        driftMs: 9_000,
        presence: "away",
      });
      expect(
        decodeWatchedAt(tableLines("roomMembers").find((line) => line.includes(awayGuest)) ?? "{}"),
      ).toStrictEqual({ presence: "away", watchedAt: lastHeard });

      await sleep(Math.max(0, lastHeard + 61_000 - Date.now()));
      expect(await hostAway()).toStrictEqual(playing);
      runInternal("maintenance:sweepRooms");

      const swept = await run(fixture.owner, "rooms.get", { roomId: room.id });

      expect(swept.clock).toStrictEqual(playing);
      expect(swept.hostAway).toBe(false);
      expect(
        swept.members
          .map((each) => [each.deviceId, each.role, each.presence, each.driftMs] as const)
          .toSorted(([left], [right]) => left.localeCompare(right)),
      ).toStrictEqual([
        [awayGuest, "guest", "away", null],
        [hostDevice, "host", "away", null],
      ]);
      expect(
        decodeHostPresence(
          tableLines("rooms").find((line) => line.includes(`quiet-host-${id}`)) ?? "{}",
        ),
      ).toStrictEqual({ status: "paused", hostAway: true });

      const rejoined = await run(fixture.member, "rooms.join", {
        roomId: room.id,
        profileId: fixture.memberProfile,
        deviceId: awayGuest,
      });

      expect(rejoined.members.find((each) => each.deviceId === awayGuest)?.presence).toBe(
        "watching",
      );

      await run(fixture.member, "rooms.heartbeat", {
        roomId: room.id,
        deviceId: awayGuest,
        presence: "away",
      });
      expect((await memberOn(fixture, room.id, awayGuest)).presence).toBe("watching");
      await run(fixture.owner, "rooms.end", { roomId: room.id, deviceId: hostDevice });
    }, 90_000);

    it("keeps a legacy member's last player report through away heartbeats inside the silence", async () => {
      const hostDevice = device("legacy-host");
      const legacyGuest = device("legacy-guest");
      const member = await run(fixture.member, "account.viewer", {});
      const heard = Date.now() - 2_000;

      const room = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: hostDevice,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      importDocuments("roomMembers", [
        JSON.stringify({
          roomId: room.id,
          userId: member.user.id,
          profileId: fixture.memberProfile,
          deviceId: legacyGuest,
          role: "guest",
          joinedAt: heard,
          lastSeenAt: heard,
        }),
      ]);

      const away = () =>
        run(fixture.member, "rooms.heartbeat", {
          roomId: room.id,
          deviceId: legacyGuest,
          presence: "away",
        });

      await away();
      await away();

      expect(
        decodeWatchedAt(
          tableLines("roomMembers").find((line) => line.includes(legacyGuest)) ?? "{}",
        ).watchedAt,
      ).toBe(heard);
      await run(fixture.owner, "rooms.end", { roomId: room.id, deviceId: hostDevice });
    });

    it("keeps a room the sweep marked host-away marked while its host only browses", async () => {
      const owner = await run(fixture.owner, "account.viewer", {});
      const file = await fileAt(fixture, `/stack-${id}/open/all-ages.mp4`);
      const now = Date.now();
      const hostDevice = DeviceIdSchema.make(`marked-host-${id}`);

      importDocuments("rooms", [
        JSON.stringify({
          titleId: fixture.titles.allAges,
          episodeId: null,
          fileId: file.fileId,
          hostUserId: owner.user.id,
          hostProfileId: fixture.ownerProfile,
          hostDeviceId: hostDevice,
          status: "paused",
          positionAtAnchorMs: 60_000,
          anchorServerTime: now - 30_000,
          playbackRate: 1,
          revision: 3,
          hostLastSeenAt: now - 30_000,
          hostAway: true,
        }),
      ]);

      const roomId = roomOf(hostDevice);

      importDocuments("roomMembers", [
        JSON.stringify({
          roomId,
          userId: owner.user.id,
          profileId: fixture.ownerProfile,
          deviceId: hostDevice,
          role: "host",
          joinedAt: now - 120_000,
          lastSeenAt: now - 30_000,
          presence: "away",
          watchedAt: now - 120_000,
        }),
      ]);

      await run(fixture.owner, "rooms.heartbeat", {
        roomId,
        deviceId: hostDevice,
        presence: "away",
      });
      expect((await run(fixture.owner, "rooms.get", { roomId })).hostAway).toBe(true);

      await run(fixture.owner, "rooms.heartbeat", { roomId, deviceId: hostDevice });
      expect((await run(fixture.owner, "rooms.get", { roomId })).hostAway).toBe(false);
      await run(fixture.owner, "rooms.end", { roomId, deviceId: hostDevice });
    });

    it("pauses a room once its host browses away from a stall or past the end", async () => {
      const hostDevice = device("stalled-host");

      const room = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: hostDevice,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      const away = (revision: number) =>
        run(fixture.owner, "rooms.heartbeat", {
          roomId: room.id,
          deviceId: hostDevice,
          revision,
          presence: "away",
        });

      const stalled = await run(fixture.owner, "rooms.buffering", {
        roomId: room.id,
        deviceId: hostDevice,
        revision: 0,
        positionMs: ms(30_000),
      });

      expect(await away(stalled.revision)).toStrictEqual(stalled);
      await sleep(PLAYER_SILENCE_MS);
      expect(await away(stalled.revision)).toMatchObject({
        status: "paused",
        positionAtAnchorMs: 30_000,
        revision: stalled.revision + 1,
      });

      const ending = await run(fixture.owner, "rooms.play", {
        roomId: room.id,
        deviceId: hostDevice,
        revision: stalled.revision + 1,
        positionMs: ms(DURATION_MS - 100),
      });

      await sleep(300);
      expect(await away(ending.revision)).toMatchObject({
        status: "paused",
        positionAtAnchorMs: DURATION_MS,
        revision: ending.revision + 1,
      });
      await run(fixture.owner, "rooms.end", { roomId: room.id, deviceId: hostDevice });
    }, 30_000);

    it("ends a room nobody has played for half an hour, though its host browses the app", async () => {
      const owner = await run(fixture.owner, "account.viewer", {});
      const file = await fileAt(fixture, `/stack-${id}/open/all-ages.mp4`);
      const now = Date.now();
      const longAgo = now - HOST_ABANDON_TIMEOUT_MS - 60_000;
      const idle = `idle-host-${id}`;
      const played = `played-host-${id}`;

      importDocuments(
        "rooms",
        [idle, played].map((hostDeviceId) =>
          JSON.stringify({
            titleId: fixture.titles.allAges,
            episodeId: null,
            fileId: file.fileId,
            hostUserId: owner.user.id,
            hostProfileId: fixture.ownerProfile,
            hostDeviceId,
            status: "paused",
            positionAtAnchorMs: 0,
            anchorServerTime: now,
            playbackRate: 1,
            revision: 1,
            hostLastSeenAt: now,
            hostAway: false,
          }),
        ),
      );

      importDocuments(
        "roomMembers",
        [
          { deviceId: idle, watchedAt: longAgo },
          { deviceId: played, watchedAt: now - 60_000 },
        ].map(({ deviceId, watchedAt }) =>
          JSON.stringify({
            roomId: roomOf(deviceId),
            userId: owner.user.id,
            profileId: fixture.ownerProfile,
            deviceId,
            role: "host",
            joinedAt: longAgo,
            lastSeenAt: now,
            presence: "away",
            watchedAt,
          }),
        ),
      );
      runInternal("maintenance:sweepRooms");

      expect(rowOf("rooms", idle).status).toBe("ended");
      expect(rowOf("rooms", played).status).toBe("paused");
      await run(fixture.owner, "rooms.end", {
        roomId: roomOf(played),
        deviceId: DeviceIdSchema.make(played),
      });
    }, 60_000);

    describe("moving on to the next episode", () => {
      const serial = { kind: "show" as const, name: `Serial ${TOKEN}`, ageRating: 7 };
      let episodes: ReadonlyArray<{ readonly id: string; readonly code: string }> = [];
      let serialId: TitleId;

      const episodeId = (code: string) => {
        const found = episodes.find((episode) => episode.code === code);

        if (found === undefined) throw new Error(`The serial has no ${code}`);

        return EpisodeIdSchema.make(found.id);
      };

      beforeAll(async () => {
        await service(fixture.mediaService, "mediaService.upsertScanned", {
          libraryId: fixture.openLibrary,
          items: [
            scanned(serialPath("s01e01"), serial, { season: 1, episode: 1 }),
            scanned(serialPath("s01e02"), serial, { season: 1, episode: 2 }),
            scanned(serialPath("s02e01"), serial, { season: 2, episode: 1 }),
            scanned(serialPath("s02e02"), serial, { season: 2, episode: 2 }),
          ],
        });
        await service(fixture.mediaService, "mediaService.markMissing", {
          libraryId: fixture.openLibrary,
          paths: [serialPath("s02e02")],
        });
        serialId = (await titleNamed(fixture.owner, fixture.ownerProfile, serial.name)).id;

        const seasons = await Promise.all(
          [1, 2].map((seasonNumber) =>
            run(fixture.owner, "titles.episodes", {
              profileId: fixture.ownerProfile,
              titleId: serialId,
              seasonNumber,
            }),
          ),
        );

        episodes = seasons.flat().map((episode) => ({
          id: episode.id,
          code: `s0${String(episode.seasonNumber)}e0${String(episode.episodeNumber)}`,
        }));
      });

      const roomOn = async (code: string, hostDevice: DeviceId, guestDevice: DeviceId) => {
        const room = await run(fixture.owner, "rooms.create", {
          profileId: fixture.ownerProfile,
          deviceId: hostDevice,
          titleId: serialId,
          episodeId: episodeId(code),
          positionMs: ms(0),
        });

        await run(fixture.member, "rooms.join", {
          roomId: room.id,
          profileId: fixture.memberProfile,
          deviceId: guestDevice,
        });

        return room;
      };

      it("lets only the host move the room on, once per episode, across seasons", async () => {
        const hostDevice = device("next-host");
        const guestDevice = device("next-guest");
        const room = await roomOn("s01e01", hostDevice, guestDevice);

        const fromFirst = {
          roomId: room.id,
          deviceId: hostDevice,
          fromEpisodeId: episodeId("s01e01"),
        };

        const onHost = { roomId: room.id, deviceId: hostDevice };
        const onGuest = { ...fromFirst, deviceId: guestDevice };

        expect(room.next).toBeNull();

        const refused = await Promise.all(
          (["rooms.startNextCountdown", "rooms.cancelNextCountdown"] as const).flatMap((name) => [
            outcome(run(fixture.member, name, onGuest)),
            outcome(run(fixture.owner, name, { ...fromFirst, deviceId: device("elsewhere") })),
          ]),
        );

        expect(refused).toStrictEqual(["forbidden", "forbidden", "forbidden", "forbidden"]);

        expect(await outcome(run(fixture.member, "rooms.playNext", onGuest))).toBe("forbidden");

        const before = Date.now();
        const counting = await run(fixture.owner, "rooms.startNextCountdown", fromFirst);

        if (counting.next?.status !== "pending") throw new Error("No countdown started");
        expect(counting.next.episode.id).toBe(episodeId("s01e02"));
        expect(counting.next.nextAt).toBeGreaterThanOrEqual(before + NEXT_EPISODE_COUNTDOWN_MS);
        expect((await run(fixture.member, "rooms.get", { roomId: room.id })).next).toStrictEqual(
          counting.next,
        );
        expect(
          (await run(fixture.owner, "rooms.startNextCountdown", fromFirst)).next,
        ).toStrictEqual(counting.next);

        const revision = counting.clock.revision;

        const raced = await Promise.all([
          run(fixture.owner, "rooms.playNext", fromFirst),
          run(fixture.owner, "rooms.playNext", fromFirst),
        ]);

        for (const answer of raced) expect(answer.episode?.id).toBe(episodeId("s01e02"));
        const moved = await run(fixture.owner, "rooms.get", { roomId: room.id });

        expect(moved.episode?.id).toBe(episodeId("s01e02"));
        expect(moved.clock).toMatchObject({
          status: "paused",
          positionAtAnchorMs: 0,
          revision: revision + 1,
        });
        expect(moved.next).toBeNull();

        expect((await run(fixture.owner, "rooms.playNext", fromFirst)).clock.revision).toBe(
          revision + 1,
        );
        expect((await run(fixture.owner, "rooms.startNextCountdown", fromFirst)).next).toBeNull();
        expect((await run(fixture.owner, "rooms.cancelNextCountdown", fromFirst)).next).toBeNull();

        const guestStream = await run(fixture.member, "playback.createSession", {
          profileId: fixture.memberProfile,
          deviceId: guestDevice,
          titleId: serialId,
          roomId: room.id,
        });

        expect(guestStream.episode?.id).toBe(episodeId("s01e02"));
        expect(guestStream.file.id).toBe(moved.fileId);

        const nextSeason = await run(fixture.owner, "rooms.playNext", {
          ...onHost,
          fromEpisodeId: episodeId("s01e02"),
        });

        expect(nextSeason.episode?.id).toBe(episodeId("s02e01"));

        const fromLast = { ...onHost, fromEpisodeId: episodeId("s02e01") };

        expect(await outcome(run(fixture.owner, "rooms.startNextCountdown", fromLast))).toBe(
          "conflict",
        );
        expect(
          await outcome(
            run(fixture.owner, "rooms.playNext", {
              ...onHost,
              fromEpisodeId: episodeId("s02e01"),
            }),
          ),
        ).toBe("conflict");
        expect((await run(fixture.owner, "rooms.get", { roomId: room.id })).next).toBeNull();
        await run(fixture.owner, "rooms.end", onHost);

        expect(await outcome(run(fixture.owner, "rooms.startNextCountdown", fromLast))).toBe(
          "conflict",
        );
      });

      it("refuses a countdown after the last episode and for a movie", async () => {
        const [, last] = await run(fixture.owner, "titles.episodes", {
          profileId: fixture.ownerProfile,
          titleId: fixture.titles.show,
          seasonNumber: 1,
        });

        if (last === undefined) throw new Error("The show has no second episode");
        const hostDevice = device("next-last");

        const onLast = await run(fixture.owner, "rooms.create", {
          profileId: fixture.ownerProfile,
          deviceId: hostDevice,
          titleId: fixture.titles.show,
          episodeId: last.id,
          positionMs: ms(0),
        });

        const fromLast = { roomId: onLast.id, deviceId: hostDevice, fromEpisodeId: last.id };

        expect(await outcome(run(fixture.owner, "rooms.startNextCountdown", fromLast))).toBe(
          "not_found",
        );
        expect(await outcome(run(fixture.owner, "rooms.playNext", fromLast))).toBe("not_found");

        const film = await run(fixture.owner, "rooms.create", {
          profileId: fixture.ownerProfile,
          deviceId: hostDevice,
          titleId: fixture.titles.allAges,
          positionMs: ms(0),
        });

        expect(
          await outcome(
            run(fixture.owner, "rooms.startNextCountdown", {
              ...fromLast,
              roomId: film.id,
            }),
          ),
        ).toBe("invalid_args");
        await run(fixture.owner, "rooms.end", { roomId: film.id, deviceId: hostDevice });
      });

      it("moves the room on when the countdown ends, without the host, unless it was cancelled or the room moved", async () => {
        const due = await roomOn("s01e01", device("due-host"), device("due-guest"));
        const cancelled = await roomOn("s01e01", device("cancel-host"), device("cancel-guest"));
        const picked = await roomOn("s01e01", device("pick-host"), device("pick-guest"));
        const onDue = { roomId: due.id, deviceId: device("due-host") };
        const onCancelled = { roomId: cancelled.id, deviceId: device("cancel-host") };
        const onPicked = { roomId: picked.id, deviceId: device("pick-host") };
        const fromFirst = { fromEpisodeId: episodeId("s01e01") };

        const counting = await Promise.all(
          [onDue, onCancelled, onPicked].map((args) =>
            run(fixture.owner, "rooms.startNextCountdown", { ...args, ...fromFirst }),
          ),
        );

        const watching = await run(fixture.owner, "rooms.cancelNextCountdown", {
          ...onCancelled,
          ...fromFirst,
        });

        expect(watching.next).toStrictEqual({ status: "cancelled" });
        expect(
          (await run(fixture.member, "rooms.get", { roomId: cancelled.id })).next,
        ).toStrictEqual({ status: "cancelled" });
        expect(
          (await run(fixture.owner, "rooms.startNextCountdown", { ...onCancelled, ...fromFirst }))
            .next,
        ).toStrictEqual({ status: "cancelled" });

        const room = await run(fixture.owner, "rooms.get", { roomId: picked.id });

        const pick = await run(fixture.owner, "rooms.setMedia", {
          ...onPicked,
          revision: room.clock.revision,
          titleId: serialId,
          episodeId: episodeId("s02e01"),
          fileId: (await fileAt(fixture, serialPath("s02e01"))).fileId,
        });

        expect(pick).toMatchObject({ status: "paused", positionAtAnchorMs: 0 });
        expect((await run(fixture.owner, "rooms.get", { roomId: picked.id })).next).toBeNull();

        const nextAt = Math.max(
          ...counting.map((each) => (each.next?.status === "pending" ? each.next.nextAt : 0)),
        );

        await sleep(nextAt - Date.now() + 2_000);

        const [afterDue, afterCancelled, afterPicked] = await Promise.all([
          run(fixture.owner, "rooms.get", { roomId: due.id }),
          run(fixture.owner, "rooms.get", { roomId: cancelled.id }),
          run(fixture.owner, "rooms.get", { roomId: picked.id }),
        ]);

        expect(afterDue.episode?.id).toBe(episodeId("s01e02"));
        expect(afterDue.clock.revision).toBe(due.clock.revision + 1);
        expect(afterDue.next).toBeNull();
        expect(afterCancelled.episode?.id).toBe(episodeId("s01e01"));
        expect(afterCancelled.next).toStrictEqual({ status: "cancelled" });
        expect(afterPicked.episode?.id).toBe(episodeId("s02e01"));
        expect(afterPicked.clock.revision).toBe(pick.revision);

        const skipped = await run(fixture.owner, "rooms.playNext", {
          ...onCancelled,
          fromEpisodeId: episodeId("s01e01"),
        });

        expect(skipped.episode?.id).toBe(episodeId("s01e02"));
        await Promise.all(
          [onDue, onCancelled, onPicked].map((args) => run(fixture.owner, "rooms.end", args)),
        );
      }, 60_000);

      it("stops a countdown when the host pauses or seeks before the credits, not within them", async () => {
        const hostDevice = device("hold-host");
        const room = await roomOn("s01e01", hostDevice, device("hold-guest"));

        const fromFirst = {
          roomId: room.id,
          deviceId: hostDevice,
          fromEpisodeId: episodeId("s01e01"),
        };

        const control = async (name: "rooms.pause" | "rooms.seek", positionMs: number) => {
          const { clock } = await run(fixture.owner, "rooms.get", { roomId: room.id });

          return run(fixture.owner, name, {
            roomId: room.id,
            deviceId: hostDevice,
            revision: clock.revision,
            positionMs: ms(positionMs),
          });
        };

        const nextOf = async () =>
          (await run(fixture.owner, "rooms.get", { roomId: room.id })).next;

        await run(fixture.owner, "rooms.startNextCountdown", fromFirst);
        await control("rooms.pause", DURATION_MS);
        await control("rooms.pause", DURATION_MS - 5_000);
        expect(await nextOf()).toMatchObject({ status: "pending" });

        await control("rooms.seek", 120_000);
        expect(await nextOf()).toBeNull();
        await run(fixture.owner, "rooms.startNextCountdown", fromFirst);
        await control("rooms.pause", DURATION_MS / 2);
        expect(await nextOf()).toBeNull();

        await run(fixture.owner, "rooms.cancelNextCountdown", fromFirst);
        await control("rooms.seek", 60_000);
        expect(await nextOf()).toStrictEqual({ status: "cancelled" });
        await run(fixture.owner, "rooms.end", { roomId: room.id, deviceId: hostDevice });
      });

      it("switches media only for the host, at the current revision, out of sight of a guest who cannot see it", async () => {
        const hostDevice = device("media-host");
        const kidDevice = device("media-kid");

        const room = await run(fixture.owner, "rooms.create", {
          profileId: fixture.ownerProfile,
          deviceId: hostDevice,
          titleId: serialId,
          episodeId: episodeId("s01e01"),
          positionMs: ms(0),
        });

        await run(fixture.member, "rooms.join", {
          roomId: room.id,
          profileId: fixture.kidsProfile,
          deviceId: kidDevice,
        });

        const change = {
          roomId: room.id,
          deviceId: hostDevice,
          revision: room.clock.revision,
          titleId: fixture.titles.adult,
        };

        expect(
          await outcome(run(fixture.member, "rooms.setMedia", { ...change, deviceId: kidDevice })),
        ).toBe("forbidden");
        expect(
          await outcome(
            run(fixture.owner, "rooms.setMedia", { ...change, deviceId: device("media-other") }),
          ),
        ).toBe("forbidden");
        expect(
          await outcome(
            run(fixture.owner, "rooms.setMedia", { ...change, revision: change.revision + 1 }),
          ),
        ).toBe("stale_revision");

        const switched = await run(fixture.owner, "rooms.setMedia", change);

        expect(switched).toMatchObject({
          status: "paused",
          positionAtAnchorMs: 0,
          revision: change.revision + 1,
        });

        expect(await outcome(run(fixture.member, "rooms.get", { roomId: room.id }))).toBe(
          "not_found",
        );
        expect(await run(fixture.member, "rooms.current", { deviceId: kidDevice })).toBeNull();
        await run(fixture.member, "rooms.heartbeat", {
          roomId: room.id,
          deviceId: kidDevice,
          presence: "away",
        });
        await run(fixture.owner, "rooms.setMedia", {
          ...change,
          revision: switched.revision,
          titleId: serialId,
          episodeId: episodeId("s01e02"),
        });

        const back = await run(fixture.member, "rooms.get", { roomId: room.id });

        expect(back.episode?.id).toBe(episodeId("s01e02"));
        expect(back.members.some((member) => member.deviceId === kidDevice)).toBe(true);

        await run(fixture.owner, "rooms.setMedia", {
          ...change,
          revision: back.clock.revision,
        });
        await run(fixture.owner, "rooms.end", { roomId: room.id, deviceId: hostDevice });
        expect(await outcome(run(fixture.member, "rooms.get", { roomId: room.id }))).toBe(
          "conflict",
        );
      });
    });

    it("keeps kids profiles out of rooms for titles they cannot see", async () => {
      const room = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: device("host2"),
        titleId: fixture.titles.adult,
        positionMs: ms(0),
      });

      expect(
        await outcome(
          run(fixture.member, "rooms.join", {
            roomId: room.id,
            profileId: fixture.kidsProfile,
            deviceId: device("kid"),
          }),
        ),
      ).toBe("not_found");
    });
  });

  describe("rich metadata", () => {
    let stranger: Member;

    beforeAll(async () => {
      const open = `/stack-${id}/open`;
      const session = await inviteMember(fixture.owner, `stranger-${id}@movies.test`);

      stranger = { session, profile: await firstProfile(session) };

      await rescan(
        fixture.mediaService,
        fixture.openLibrary,
        `${open}/all-ages.mp4`,
        { name: `All Ages ${TOKEN}`, ageRating: 0 },
        {
          year: 1999,
          genres: ["Drama", `Genre ${id}`],
          externalIds: { tmdb: `all${id}`, imdb: null, tvdb: null },
          studios: [`Studio ${id}`],
          countries: ["Canada"],
          tags: [`tag-${id}`],
          releaseDate: "1999-03-31",
          originalLanguage: "en",
          ratings: {
            tmdb: { value: 7.1, votes: 900 },
            imdb: { value: 8.7, votes: 2_000_000 },
            rottenTomatoes: 88,
            metacritic: 73,
          },
          trailer: { site: "youtube", key: "dQw4w9WgXcQ", name: "Trailer" },
          recommendations: [`adult${id}`, `hidden${id}`],
        },
      );

      await rescan(
        fixture.mediaService,
        fixture.openLibrary,
        `${open}/adult.mp4`,
        { name: `Adult ${TOKEN}`, ageRating: 17 },
        {
          year: 2012,
          genres: [`Genre ${id}`],
          externalIds: { tmdb: `adult${id}`, imdb: null, tvdb: null },
          ratings: {
            tmdb: { value: 5.5, votes: 10 },
            imdb: null,
            rottenTomatoes: null,
            metacritic: null,
          },
          trailer: null,
        },
      );

      await rescan(
        fixture.mediaService,
        fixture.restrictedLibrary,
        `/stack-${id}/restricted/hidden.mp4`,
        { name: `Hidden ${TOKEN}`, ageRating: 0 },
        { genres: [`Genre ${id}`], externalIds: { tmdb: `hidden${id}`, imdb: null, tvdb: null } },
      );

      const credits = [
        actor("Lead", "1", 0),
        actor("Second", null, 1),
        { person: creditedPerson("Maker", "2"), kind: "director" as const, role: null, order: 2 },
      ];

      await Promise.all(
        [fixture.titles.allAges, fixture.titles.adult, fixture.titles.hidden].map((titleId) =>
          service(fixture.mediaService, "mediaService.applyCredits", {
            titleId,
            episodeId: null,
            credits: titleId === fixture.titles.allAges ? credits : [actor("Lead", "1", 0)],
            hash: `${titleId}-v1`,
          }),
        ),
      );

      await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.adult,
        episodeId: null,
        credits: [actor("Lead", "1", 0), actor("Grown", "3", 1)],
        hash: "adult-v2",
      });

      const collection = {
        sourceKey: `tmdb:collection${id}`,
        name: `Saga ${TOKEN}`,
        overview: "Every film of the saga.",
        poster: null,
        backdrop: null,
      };

      await service(fixture.mediaService, "mediaService.applyCollection", {
        titleId: fixture.titles.adult,
        collection,
        hash: "saga-v1",
      });

      await service(fixture.mediaService, "mediaService.applyCollection", {
        titleId: fixture.titles.allAges,
        collection,
        hash: "saga-v1",
      });
    }, 60_000);

    it("shows cast, crew, scores, studios, the trailer, and the collection on the title", async () => {
      const title = await run(fixture.member, "titles.get", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.allAges,
      });

      expect(title.cast.map((entry) => [entry.name, entry.role])).toStrictEqual([
        [`Lead ${TOKEN}`, "Role of Lead"],
        [`Second ${TOKEN}`, "Role of Second"],
      ]);
      expect(title.crew.map((entry) => [entry.name, entry.kind])).toStrictEqual([
        [`Maker ${TOKEN}`, "director"],
      ]);
      expect(title.ratings.imdb).toStrictEqual({ value: 8.7, votes: 2_000_000 });
      expect(title.ratings.rottenTomatoes).toBe(88);
      expect(title.studios).toStrictEqual([`Studio ${id}`]);
      expect(title.tags).toStrictEqual([`tag-${id}`]);
      expect(title.releaseDate).toBe("1999-03-31");
      expect(title.trailer).toStrictEqual({ site: "youtube", key: "dQw4w9WgXcQ", name: "Trailer" });
      expect(title.collection?.name).toBe(`Saga ${TOKEN}`);

      const adult = await run(fixture.member, "titles.get", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.adult,
      });

      expect(adult.trailer).toBeNull();
      expect(adult.cast.map((entry) => entry.name)).toStrictEqual([
        `Lead ${TOKEN}`,
        `Grown ${TOKEN}`,
      ]);
    });

    it("keeps provider IDs a migration imported when the title is scanned again", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const { jobId, worker } = await claimMigration(fixture, owner, `server-ids-${id}`);

      await service(fixture.mediaService, "migrationService.importOverrides", {
        jobId,
        workerId: worker,
        items: [
          {
            titleId: fixture.titles.unrated,
            overrides: {},
            externalIds: { tmdb: `unrated${id}`, imdb: null, tvdb: null },
          },
        ],
      });

      await service(fixture.mediaService, "mediaService.completeJob", { jobId, workerId: worker });

      await service(fixture.mediaService, "mediaService.upsertScanned", {
        libraryId: fixture.openLibrary,
        items: [
          scanned(
            `/stack-${id}/open/unrated.mp4`,
            { kind: "movie", name: `Unrated ${TOKEN}`, ageRating: null },
            null,
          ),
        ],
      });

      const title = await run(fixture.owner, "titles.get", {
        profileId: fixture.ownerProfile,
        titleId: fixture.titles.unrated,
      });

      expect(title.externalIds.tmdb).toBe(`unrated${id}`);
    });

    it("keeps one person when an IMDb-only credit and a TMDB credit name them", async () => {
      const imdbOnly = {
        person: {
          name: `Twice ${TOKEN}`,
          externalIds: { tmdb: null, imdb: `nm${id}`, tvdb: null },
          profile: null,
        },
        kind: "actor" as const,
        role: null,
        order: 0,
      };

      const tmdbOnly = {
        ...imdbOnly,
        person: { ...imdbOnly.person, externalIds: { tmdb: `twice${id}`, imdb: null, tvdb: null } },
      };

      await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.unrated,
        episodeId: null,
        credits: [imdbOnly],
        hash: "twice-v1",
      });

      await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.show,
        episodeId: null,
        credits: [tmdbOnly],
        hash: "twice-v2",
      });

      const found = (
        await run(fixture.owner, "people.search", {
          profileId: fixture.ownerProfile,
          query: `Twice ${TOKEN}`,
        })
      ).filter((person) => person.name === `Twice ${TOKEN}`);

      expect(found).toHaveLength(1);

      const twice = found[0]?.id;

      if (twice === undefined) throw new Error("Nobody was credited");

      const detail = await run(fixture.owner, "people.get", {
        profileId: fixture.ownerProfile,
        personId: twice,
      });

      expect(detail.externalIds).toStrictEqual({ tmdb: `twice${id}`, imdb: `nm${id}`, tvdb: null });
      expect(detail.credits.map((entry) => entry.title.id).toSorted()).toStrictEqual(
        [fixture.titles.unrated, fixture.titles.show].toSorted(),
      );
    });

    it("keeps stored scores and provider IDs that a rescan cannot fetch", async () => {
      await rescan(
        fixture.mediaService,
        fixture.openLibrary,
        `/stack-${id}/open/all-ages.mp4`,
        { name: `All Ages ${TOKEN}`, ageRating: 0 },
        {
          year: 1999,
          genres: ["Drama", `Genre ${id}`],
          ratings: {
            tmdb: { value: 7.2, votes: 950 },
            imdb: null,
            rottenTomatoes: null,
            metacritic: null,
          },
        },
      );

      const title = await run(fixture.member, "titles.get", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.allAges,
      });

      expect(title.ratings).toStrictEqual({
        tmdb: { value: 7.2, votes: 950 },
        imdb: { value: 8.7, votes: 2_000_000 },
        rottenTomatoes: 88,
        metacritic: 73,
      });
      expect(title.externalIds.tmdb).toBe(`all${id}`);
    });

    it("lets a refresh fill credits but not replace a scan's, nor describe others' people", async () => {
      const { jobId } = await run(fixture.owner, "metadata.refresh", {
        titleId: fixture.titles.allAges,
      });

      const workerId = `refresher-${id}`;

      await service(fixture.mediaService, "mediaService.claimJob", {
        jobId,
        workerId,
        leaseMs: 60_000,
      });

      const lease = { jobId, workerId };

      const refreshed = await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.allAges,
        episodeId: null,
        credits: [actor("Provider Only", "99", 0)],
        hash: "refresh-v1",
        lease,
      });

      expect(refreshed.written).toBe(false);
      expect(refreshed.people.map((person) => person.tmdbId)).toContain(`1${id}`);

      const grown = await findPerson(fixture.owner, fixture.ownerProfile, "Grown");

      expect(
        await outcome(
          service(fixture.mediaService, "mediaService.applyPerson", {
            ...lease,
            personId: grown,
            details: {
              name: `Grown ${TOKEN}`,
              externalIds: { tmdb: null, imdb: null, tvdb: null },
              profile: null,
              biography: "Not theirs to write.",
              birthDate: null,
              deathDate: null,
              birthPlace: null,
              knownFor: null,
            },
          }),
        ),
      ).toBe("invalid_args");

      await service(fixture.mediaService, "mediaService.completeJob", lease);
    });

    it("writes credits again only when their digest changes", async () => {
      const again = await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.adult,
        episodeId: null,
        credits: [],
        hash: "adult-v2",
      });

      expect(again).toStrictEqual({ written: false, people: [] });
    });

    it("shows a person only through titles the profile may see", async () => {
      const lead = await findPerson(fixture.owner, fixture.ownerProfile, "Lead");
      const grown = await findPerson(fixture.owner, fixture.ownerProfile, "Grown");

      const forOwner = await run(fixture.owner, "people.get", {
        profileId: fixture.ownerProfile,
        personId: lead,
      });

      expect(forOwner.credits.map((entry) => entry.title.id).toSorted()).toStrictEqual(
        [fixture.titles.allAges, fixture.titles.adult, fixture.titles.hidden].toSorted(),
      );
      expect(forOwner.detailsPending).toBe(true);

      const forMember = await run(stranger.session, "people.get", {
        profileId: stranger.profile,
        personId: lead,
      });

      expect(forMember.credits.map((entry) => entry.title.id).toSorted()).toStrictEqual(
        [fixture.titles.allAges, fixture.titles.adult].toSorted(),
      );

      const forKids = await run(fixture.member, "people.get", {
        profileId: fixture.kidsProfile,
        personId: lead,
      });

      expect(forKids.credits.map((entry) => entry.title.id).toSorted()).toStrictEqual(
        [fixture.titles.allAges, fixture.titles.hidden].toSorted(),
      );

      expect(
        await outcome(
          run(fixture.member, "people.get", { profileId: fixture.kidsProfile, personId: grown }),
        ),
      ).toBe("not_found");
      expect(await searchPeople(fixture.member, fixture.kidsProfile, "Grown")).not.toContain(grown);
      expect((await searchPeople(stranger.session, stranger.profile, "Grown"))[0]).toBe(grown);
    });

    it("queues one person job per request window and writes the details it fetches", async () => {
      const lead = await findPerson(fixture.owner, fixture.ownerProfile, "Lead");
      const args = { profileId: fixture.memberProfile, personId: lead };

      await run(fixture.member, "people.requestDetails", args);
      await run(fixture.member, "people.requestDetails", args);

      const queued = (await run(fixture.owner, "jobs.list", { kind: "person", limit: 100 })).filter(
        (job) => job.payload.kind === "person" && job.payload.personId === lead,
      );

      expect(queued).toHaveLength(1);
      const [job] = queued;

      if (job === undefined) throw new Error("No person job was queued");
      const workerId = `person-worker-${id}`;

      await service(fixture.mediaService, "mediaService.claimJob", {
        jobId: job.id,
        workerId,
        leaseMs: 60_000,
      });

      const target = await service(fixture.mediaService, "mediaService.personTarget", {
        personId: lead,
      });

      expect(target.externalIds.tmdb).toBe(`1${id}`);

      expect(
        await outcome(
          service(fixture.mediaService, "mediaService.applyPerson", {
            jobId: job.id,
            workerId,
            personId: await findPerson(fixture.owner, fixture.ownerProfile, "Maker"),
            details: {
              name: `Maker ${TOKEN}`,
              externalIds: { tmdb: null, imdb: null, tvdb: null },
              profile: null,
              biography: null,
              birthDate: null,
              deathDate: null,
              birthPlace: null,
              knownFor: null,
            },
          }),
        ),
      ).toBe("invalid_args");

      await service(fixture.mediaService, "mediaService.applyPerson", {
        jobId: job.id,
        workerId,
        personId: lead,
        details: {
          name: target.name,
          externalIds: { tmdb: target.externalIds.tmdb, imdb: "nm0000001", tvdb: null },
          profile: null,
          biography: "Plays leads.",
          birthDate: "1970-01-01",
          deathDate: null,
          birthPlace: "Montreal",
          knownFor: "Acting",
        },
      });

      await service(fixture.mediaService, "mediaService.completeJob", { jobId: job.id, workerId });

      const detail = await run(fixture.member, "people.get", args);

      expect(detail.biography).toBe("Plays leads.");
      expect(detail.externalIds.imdb).toBe("nm0000001");
      expect(detail.detailsPending).toBe(false);
    });

    it("filters lists by genre, years, studio, and score, and counts genres", async () => {
      const names = async (filters: ListFilters) =>
        (
          await run(stranger.session, "titles.list", {
            profileId: stranger.profile,
            kind: "movie",
            sort: "added",
            limit: 100,
            ...filters,
          })
        ).items.flatMap((title) => (title.name.includes(TOKEN) ? [title.name] : []));

      expect((await names({ genre: `genre ${id}` })).toSorted()).toStrictEqual(
        [`Adult ${TOKEN}`, `All Ages ${TOKEN}`].toSorted(),
      );
      expect(await names({ genre: `Genre ${id}`, yearFrom: 2010, yearTo: 2019 })).toStrictEqual([
        `Adult ${TOKEN}`,
      ]);
      expect(await names({ studio: `studio ${id}` })).toStrictEqual([`All Ages ${TOKEN}`]);
      expect(await names({ genre: `Genre ${id}`, minRating: 8 })).toStrictEqual([
        `All Ages ${TOKEN}`,
      ]);

      const genres = await run(fixture.member, "titles.genres", {
        profileId: fixture.kidsProfile,
        kind: "movie",
      });

      expect(genres.find((genre) => genre.name === `Genre ${id}`)?.count).toBe(2);
    });

    it("recommends provider matches the profile may see, then titles alike", async () => {
      const similar = async (session: Session, profileId: ProfileId) =>
        (await run(session, "titles.similar", { profileId, titleId: fixture.titles.allAges })).map(
          (title) => title.id,
        );

      expect((await similar(stranger.session, stranger.profile))[0]).toBe(fixture.titles.adult);
      expect(await similar(stranger.session, stranger.profile)).not.toContain(
        fixture.titles.hidden,
      );
      expect(await similar(fixture.member, fixture.kidsProfile)).not.toContain(
        fixture.titles.adult,
      );
      expect(
        (
          await run(fixture.owner, "titles.similar", {
            profileId: fixture.ownerProfile,
            titleId: fixture.titles.allAges,
          })
        )
          .map((title) => title.id)
          .slice(0, 2),
      ).toStrictEqual([fixture.titles.adult, fixture.titles.hidden]);
    });

    it("lists another library's copy of a title once, and never the title's own copy", async () => {
      const copies = await run(fixture.owner, "libraries.create", {
        name: `Copies ${id}`,
        kind: "movies",
        roots: [`/stack-${id}/copies`],
      });

      await service(fixture.mediaService, "mediaService.upsertScanned", {
        libraryId: copies.libraryId,
        items: [
          ["adult", `Adult Copy ${TOKEN}`, 17],
          ["all", `All Ages Copy ${TOKEN}`, 0],
        ].map(([key, name, ageRating]) =>
          scanned(
            `/stack-${id}/copies/${String(key)}.mp4`,
            { kind: "movie", name: String(name), ageRating: Number(ageRating) },
            null,
            {
              title: {
                genres: ["Drama", `Genre ${id}`],
                studios: [`Studio ${id}`],
                externalIds: { tmdb: `${String(key)}${id}`, imdb: null, tvdb: null },
              },
            },
          ),
        ),
      });

      const listed = await run(fixture.owner, "titles.similar", {
        profileId: fixture.ownerProfile,
        titleId: fixture.titles.allAges,
      });

      const names = listed.map((title) => title.name);

      expect(names.filter((name) => name.startsWith("Adult"))).toHaveLength(1);
      expect(names).not.toContain(`All Ages Copy ${TOKEN}`);

      await run(fixture.owner, "libraries.remove", { libraryId: copies.libraryId });
    });

    it("shows a collection's visible titles in year order, and hides one with none", async () => {
      const { collection } = await run(fixture.member, "titles.get", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.allAges,
      });

      if (collection === null) throw new Error("The title lost its collection");

      const full = await run(fixture.member, "collections.get", {
        profileId: fixture.memberProfile,
        collectionId: collection.id,
      });

      expect(full.overview).toBe("Every film of the saga.");
      expect(full.titles.map((title) => title.id)).toStrictEqual([
        fixture.titles.allAges,
        fixture.titles.adult,
      ]);

      const forKids = await run(fixture.member, "collections.get", {
        profileId: fixture.kidsProfile,
        collectionId: collection.id,
      });

      expect(forKids.titles.map((title) => title.id)).toStrictEqual([fixture.titles.allAges]);

      await service(fixture.mediaService, "mediaService.applyCollection", {
        titleId: fixture.titles.allAges,
        collection: null,
        hash: "none",
      });

      expect(
        await outcome(
          run(fixture.member, "collections.get", {
            profileId: fixture.kidsProfile,
            collectionId: collection.id,
          }),
        ),
      ).toBe("not_found");
    });

    it("lists an episode's guest stars, score, and IDs", async () => {
      const [first] = await run(fixture.member, "titles.episodes", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
        seasonNumber: 1,
      });

      if (first === undefined) throw new Error("The show has no episodes");

      await service(fixture.mediaService, "mediaService.upsertScanned", {
        libraryId: fixture.openLibrary,
        items: [
          scanned(
            `/stack-${id}/open/show/s01e01.mp4`,
            { kind: "show", name: `Show ${TOKEN}`, ageRating: 7 },
            { season: 1, episode: 1 },
            {
              episode: {
                rating: { value: 8.4, votes: 50 },
                externalIds: { tmdb: `episode${id}`, imdb: null, tvdb: null },
              },
            },
          ),
        ],
      });

      await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.show,
        episodeId: first.id,
        credits: [
          { person: creditedPerson("Guest", null), kind: "guest-star", role: "Visitor", order: 0 },
        ],
        hash: "episode-v1",
      });

      const [episode] = await run(fixture.member, "titles.episodes", {
        profileId: fixture.memberProfile,
        titleId: fixture.titles.show,
        seasonNumber: 1,
      });

      expect(episode?.rating).toBe(8.4);
      expect(episode?.externalIds.tmdb).toBe(`episode${id}`);
      expect(episode?.credits.map((entry) => [entry.name, entry.kind])).toStrictEqual([
        [`Guest ${TOKEN}`, "guest-star"],
      ]);
    });

    it("finds a person whose first credits are all on titles the profile may not see", async () => {
      const roles = Array.from({ length: 12 }, (_, index) => ({
        ...actor("Prolific", "4", index + 1),
        role: `Part ${index}`,
      }));

      await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.hidden,
        episodeId: null,
        credits: [actor("Lead", "1", 0), ...roles],
        hash: "hidden-v2",
      });

      const prolific = await findPerson(fixture.owner, fixture.ownerProfile, "Prolific");

      expect(await searchPeople(stranger.session, stranger.profile, "Prolific")).not.toContain(
        prolific,
      );

      await service(fixture.mediaService, "mediaService.applyCredits", {
        titleId: fixture.titles.show,
        episodeId: null,
        credits: [actor("Prolific", "4", 0)],
        hash: "show-v1",
      });

      expect((await searchPeople(stranger.session, stranger.profile, "Prolific"))[0]).toBe(
        prolific,
      );
    });

    it("keeps a title an import put in its metadata collection when a later import leaves it out", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const { jobId, worker } = await claimMigration(fixture, owner, `server-saga-${id}`);
      const lease = { jobId, workerId: worker };
      const sourceKey = `jellyfin:${id}:imported-saga`;
      const name = `Imported ${TOKEN}`;

      await service(fixture.mediaService, "migrationService.importCollections", {
        ...lease,
        items: [{ sourceKey, name, sortName: null, titleIds: [fixture.titles.hidden] }],
      });

      await service(fixture.mediaService, "mediaService.applyCollection", {
        titleId: fixture.titles.hidden,
        collection: { sourceKey, name, overview: null, poster: null, backdrop: null },
        hash: "imported-v1",
      });

      await service(fixture.mediaService, "migrationService.importCollections", {
        ...lease,
        items: [{ sourceKey, name, sortName: null, titleIds: [] }],
      });

      const { collection } = await run(fixture.owner, "titles.get", {
        profileId: fixture.ownerProfile,
        titleId: fixture.titles.hidden,
      });

      if (collection === null) throw new Error("The title lost its collection");

      expect(collection.name).toBe(name);

      const full = await run(fixture.owner, "collections.get", {
        profileId: fixture.ownerProfile,
        collectionId: collection.id,
      });

      expect(full.titles.map((title) => title.id)).toStrictEqual([fixture.titles.hidden]);
    });
  });

  describe("API key lifetimes and ownership", () => {
    it("ends a key's session when the key expires, even with a token still valid", async () => {
      const memberId = (await run(fixture.member, "account.viewer", {})).user.id;
      const secret = `mk_expiring_${id}_${"k".repeat(32)}`;
      const expiresAt = Date.now() + 20_000;

      importDocuments("apiKeys", [
        JSON.stringify({
          userId: memberId,
          name: `Expiring ${id}`,
          prefix: "mk_expiring",
          hash: sha256(secret),
          scopes: ["read"],
          expiresAt,
        }),
      ]);

      const agent = await signIn(url, { provider: "apikey", params: { key: secret } });

      expect(await outcome(run(agent, "account.viewer", {}))).toBe("succeeded");
      await sleep(expiresAt - Date.now() + 1_000);
      expect(await outcome(run(agent, "account.viewer", {}))).toBe("unauthenticated");
      expect(await trySignIn(url, { provider: "apikey", params: { key: secret } })).toBeNull();
    }, 60_000);

    it("keeps the owner's keys from other admins", async () => {
      const email = `keys-admin-${id}@movies.test`;
      const invite = await run(fixture.owner, "invites.create", { email, role: "admin" });
      const admin = await signIn(url, password(email, "signUp", invite.code));
      const ownerId = (await run(fixture.owner, "account.viewer", {})).user.id;
      const memberId = (await run(fixture.member, "account.viewer", {})).user.id;

      const ownerKey = await run(fixture.owner, "apiKeys.create", {
        name: `Owner ${id}`,
        scopes: ["read"],
      });

      expect(await outcome(run(admin, "apiKeys.list", { userId: ownerId }))).toBe("forbidden");
      expect(await outcome(run(admin, "apiKeys.revoke", { apiKeyId: ownerKey.apiKey.id }))).toBe(
        "not_found",
      );
      expect(await outcome(run(admin, "apiKeys.list", { userId: memberId }))).toBe("succeeded");

      const agent = await signIn(url, { provider: "apikey", params: { key: ownerKey.secret } });

      expect(await outcome(run(agent, "account.viewer", {}))).toBe("succeeded");
      await run(fixture.owner, "apiKeys.revoke", { apiKeyId: ownerKey.apiKey.id });
    });
  });

  describe("admin jobs", () => {
    it("keeps backup and migration jobs from sessions without admin", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const { jobId, worker } = await claimMigration(fixture, owner, `server-jobs-${id}`);

      const created = await run(fixture.owner, "apiKeys.create", {
        name: `Manager ${id}`,
        scopes: ["manage"],
      });

      const manager = await signIn(url, { provider: "apikey", params: { key: created.secret } });
      const listed = await run(manager, "jobs.list", { limit: 100 });

      expect(listed.filter((job) => job.kind === "migration" || job.kind === "backup")).toEqual([]);
      expect(await outcome(run(manager, "jobs.list", { kind: "migration" }))).toBe("forbidden");
      expect(await outcome(run(manager, "jobs.get", { jobId }))).toBe("forbidden");
      expect(await outcome(run(manager, "jobs.cancel", { jobId }))).toBe("forbidden");
      expect((await run(fixture.owner, "jobs.get", { jobId })).status).toBe("running");

      await service(fixture.mediaService, "mediaService.completeJob", { jobId, workerId: worker });
      await run(fixture.owner, "apiKeys.revoke", { apiKeyId: created.apiKey.id });
    });

    it("fills a manager's job list past many newer backup jobs", async () => {
      const { jobId } = await run(fixture.owner, "metadata.refresh", {
        titleId: fixture.titles.show,
      });

      importDocuments(
        "jobs",
        Array.from({ length: 520 }, () =>
          JSON.stringify({
            kind: "backup",
            status: "succeeded",
            payload: { kind: "backup", trigger: "manual" },
            progress: { done: 1, total: 1, message: null },
            error: null,
            requestedBy: null,
            attempts: 1,
            startedAt: Date.now(),
            finishedAt: Date.now(),
          }),
        ),
      );

      const created = await run(fixture.owner, "apiKeys.create", {
        name: `Pager ${id}`,
        scopes: ["manage"],
      });

      const manager = await signIn(url, { provider: "apikey", params: { key: created.secret } });
      const listed = await run(manager, "jobs.list", { limit: 5 });

      expect(listed.map((job) => job.id)).toContain(jobId);
      expect(listed.filter((job) => job.kind === "backup")).toEqual([]);

      await run(fixture.owner, "jobs.cancel", { jobId });
      await run(fixture.owner, "apiKeys.revoke", { apiKeyId: created.apiKey.id });
    });

    it("imports collections only under a migration job's lease", async () => {
      const { jobId } = await run(fixture.owner, "metadata.refresh", {
        titleId: fixture.titles.allAges,
      });

      const workerId = `metadata-${id}`;

      await service(fixture.mediaService, "mediaService.claimJob", {
        jobId,
        workerId,
        leaseMs: 60_000,
      });

      expect(
        await outcome(
          service(fixture.mediaService, "migrationService.importCollections", {
            jobId,
            workerId,
            items: [],
          }),
        ),
      ).toBe("invalid_args");

      await service(fixture.mediaService, "mediaService.completeJob", { jobId, workerId });
    });
  });

  describe("library folders", () => {
    it("refuses folders inside or around another library's", async () => {
      const create = (roots: ReadonlyArray<string>) =>
        run(fixture.owner, "libraries.create", { name: `Nested ${id}`, kind: "movies", roots });

      expect(await outcome(create([`/stack-${id}/open/inner`]))).toBe("invalid_args");
      expect(await outcome(create([`/stack-${id}`]))).toBe("invalid_args");
      expect(await outcome(create([`//stack-${id}//open/`]))).toBe("conflict");
      expect(await outcome(create([`/stack-${id}/own`, `/stack-${id}/own/inner`]))).toBe(
        "invalid_args",
      );
      expect(
        await outcome(
          run(fixture.owner, "libraries.update", {
            libraryId: fixture.restrictedLibrary,
            roots: [`/stack-${id}/open/moved`],
          }),
        ),
      ).toBe("invalid_args");
    });

    it("reports libraries that overlapped before folders were kept apart", async () => {
      const ownerId = (await run(fixture.owner, "account.viewer", {})).user.id;

      importDocuments("libraries", [
        JSON.stringify({
          name: `Legacy ${id}`,
          kind: "movies",
          roots: [`/stack-${id}/open/legacy`],
          access: "restricted",
          createdBy: ownerId,
          titleCount: 0,
          lastScanAt: null,
        }),
      ]);

      expect(runInternal("maintenance:overlappingLibraries")).toContain(`Legacy ${id}`);

      const legacy = (await run(fixture.owner, "libraries.listDetails", {})).find(
        (library) => library.name === `Legacy ${id}`,
      );

      if (legacy !== undefined) {
        await run(fixture.owner, "libraries.remove", { libraryId: legacy.id });
      }
    });

    it("renames, opens, and removes a library", async () => {
      const created = await run(fixture.owner, "libraries.create", {
        name: `Spare ${id}`,
        kind: "movies",
        roots: [`/stack-${id}/spare`],
        access: "restricted",
      });

      const updated = await run(fixture.owner, "libraries.update", {
        libraryId: created.libraryId,
        name: `Renamed ${id}`,
        access: "everyone",
      });

      expect(updated).toMatchObject({ name: `Renamed ${id}`, access: "everyone" });
      expect(
        (await run(fixture.member, "libraries.list", {})).map((library) => library.id),
      ).toContain(created.libraryId);

      await run(fixture.owner, "libraries.remove", { libraryId: created.libraryId });
      expect(
        (await run(fixture.member, "libraries.list", {})).map((library) => library.id),
      ).not.toContain(created.libraryId);
      expect(
        await outcome(run(fixture.owner, "libraries.get", { libraryId: created.libraryId })),
      ).toBe("not_found");
    });
  });

  describe("migrated library access", () => {
    it("shares an added library as the source did, and with admins only when it does not say", async () => {
      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const memberId = (await run(fixture.member, "account.viewer", {})).user.id;
      const serverId = `server-access-${id}`;

      const { jobId } = await service(fixture.mediaService, "migrationService.start", {
        requestedBy: owner,
        source: "jellyfin",
        serverName: "Jellyfin",
        plan: {
          ...plan(serverId, [
            { sourceUserId: "source-owner", profileId: fixture.ownerProfile },
            { sourceUserId: "source-member", profileId: fixture.memberProfile },
          ]),
          libraries: [
            {
              name: "migrated-all",
              kind: "movies",
              roots: [`/stack-${id}/migrated-all`],
              access: { kind: "everyone" },
            },
            {
              name: "migrated-some",
              kind: "movies",
              roots: [`/stack-${id}/migrated-some/`],
              access: { kind: "users", sourceUserIds: ["source-member", "gone"] },
            },
          ],
        },
      });

      const workerId = `migrator-${serverId}`;

      await service(fixture.mediaService, "mediaService.claimJob", {
        jobId,
        workerId,
        leaseMs: 60_000,
      });

      const ensure = async (folder: string) => {
        const result = await service(fixture.mediaService, "migrationService.ensureLibrary", {
          jobId,
          workerId,
          name: folder,
          kind: "movies",
          roots: [`/stack-${id}/${folder}`],
        });

        const [libraryId] = result.libraryIds;

        if (libraryId === undefined) throw new Error("ensureLibrary returned no library");

        return run(fixture.owner, "libraries.get", { libraryId });
      };

      expect(await ensure("migrated-all")).toMatchObject({
        access: "everyone",
        grantedUserIds: [],
      });
      expect(await ensure("migrated-some")).toMatchObject({
        access: "restricted",
        grantedUserIds: [memberId],
      });

      const unknown = await ensure("migrated-unknown");

      expect(unknown).toMatchObject({ access: "restricted", grantedUserIds: [] });
      expect(
        (await run(fixture.member, "libraries.list", {})).map((library) => library.name),
      ).toEqual(expect.arrayContaining(["migrated-all", "migrated-some"]));
      expect(
        (await run(fixture.member, "libraries.list", {})).map((library) => library.id),
      ).not.toContain(unknown.id);

      expect(
        await service(fixture.mediaService, "migrationService.ensureLibrary", {
          jobId,
          workerId,
          name: "Around",
          kind: "movies",
          roots: [`/stack-${id}`],
        }),
      ).toMatchObject({ created: false });

      await service(fixture.mediaService, "mediaService.completeJob", { jobId, workerId });
    });
  });

  describe("kids profiles", () => {
    it("always keeps an age limit on a kids profile", async () => {
      const profile = await run(fixture.member, "profiles.create", {
        name: `Growing ${id}`,
        avatar: "owl",
        kids: false,
      });

      expect(profile.maxAgeRating).toBeNull();

      const kids = await run(fixture.member, "profiles.update", {
        profileId: profile.id,
        kids: true,
      });

      expect(kids.maxAgeRating).toBe(7);
      expect(
        await outcome(
          run(fixture.member, "profiles.update", { profileId: profile.id, maxAgeRating: null }),
        ),
      ).toBe("invalid_args");
      expect(
        await run(fixture.member, "profiles.update", {
          profileId: profile.id,
          kids: false,
          maxAgeRating: null,
        }),
      ).toMatchObject({ kids: false, maxAgeRating: null });
    });

    it("removes a profile with its list and progress, but never the last one", async () => {
      const email = `single-${id}@movies.test`;
      const single = await inviteMember(fixture.owner, email);
      const only = await firstProfile(single);

      expect(await outcome(run(single, "profiles.remove", { profileId: only }))).toBe("conflict");

      const spare = await run(single, "profiles.create", {
        name: `Spare ${id}`,
        avatar: "fox",
        kids: false,
      });

      await run(single, "myList.add", { profileId: spare.id, titleId: fixture.titles.allAges });

      const playing = await run(single, "playback.createSession", {
        profileId: spare.id,
        deviceId: device("spare-tv"),
        titleId: fixture.titles.allAges,
      });

      const hostDevice = device("spare-host");

      await run(single, "rooms.create", {
        profileId: spare.id,
        deviceId: hostDevice,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      const switchedHost = device("spare-switched-host");

      const switched = await run(single, "rooms.create", {
        profileId: spare.id,
        deviceId: switchedHost,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      await run(single, "rooms.join", {
        roomId: switched.id,
        profileId: only,
        deviceId: switchedHost,
      });

      await run(single, "profiles.remove", { profileId: spare.id });
      expect((await run(single, "profiles.list", {})).map((profile) => profile.id)).toStrictEqual([
        only,
      ]);
      expect(await outcome(run(single, "titles.home", { profileId: spare.id }))).toBe("not_found");

      expect(
        await run(single, "playback.reportProgress", {
          sessionId: playing.sessionId,
          positionMs: ms(60_000),
          event: "tick",
        }),
      ).toStrictEqual({ applied: false, watched: false });
      expect(rowOf("rooms", hostDevice).status).toBe("ended");
      expect(rowOf("rooms", switchedHost).status).toBe("ended");
      expect(await run(single, "rooms.current", { deviceId: hostDevice })).toBeNull();
    });
  });

  describe("argument bounds", () => {
    it("refuses names, avatars, device IDs, folders, positions, and overrides outside the contract", async () => {
      const started = await run(fixture.member, "playback.createSession", {
        profileId: fixture.memberProfile,
        deviceId: device("bounds"),
        titleId: fixture.titles.allAges,
      });

      const progress = (positionMs: number, durationMs: number) =>
        direct(fixture.member, "mutation", "playback:reportProgress", {
          sessionId: started.sessionId,
          positionMs,
          durationMs,
          event: "tick",
        });

      const calls = {
        clientNameLong: direct(anonymous(url), "action", "deviceAuth:request", {
          clientName: long(81),
        }),
        clientNameBlank: direct(anonymous(url), "action", "deviceAuth:request", {
          clientName: "   ",
        }),
        avatarEmpty: direct(fixture.member, "mutation", "profiles:create", {
          name: `Bounds ${id}`,
          avatar: "",
          kids: false,
        }),
        avatarLong: direct(fixture.member, "mutation", "profiles:create", {
          name: `Bounds ${id}`,
          avatar: long(41),
          kids: false,
        }),
        keyName: direct(fixture.member, "action", "apiKeys:create", {
          name: "  ",
          scopes: ["read"],
        }),
        folder: direct(fixture.owner, "mutation", "libraries:create", {
          name: `Bounds ${id}`,
          kind: "movies",
          roots: [`/${long(1024)}`],
        }),
        fractionalYear: direct(fixture.owner, "mutation", "metadata:edit", {
          titleId: fixture.titles.unrated,
          set: { year: 1999.5 },
        }),
        blankSortName: direct(fixture.owner, "mutation", "metadata:edit", {
          titleId: fixture.titles.unrated,
          set: { sortName: "  " },
        }),
        negativeAgeRating: direct(fixture.owner, "mutation", "metadata:edit", {
          titleId: fixture.titles.unrated,
          set: { ageRating: -1 },
        }),
        playbackDevice: direct(fixture.member, "mutation", "playback:createSession", {
          profileId: fixture.memberProfile,
          deviceId: long(129),
          titleId: fixture.titles.allAges,
        }),
        roomDevice: direct(fixture.member, "mutation", "rooms:create", {
          profileId: fixture.memberProfile,
          deviceId: long(129),
          titleId: fixture.titles.allAges,
          positionMs: 0,
        }),
        negativeDuration: progress(1_000, -1),
        infiniteDuration: progress(1_000, Number.POSITIVE_INFINITY),
      };

      const codes = Object.fromEntries(
        await Promise.all(
          Object.entries(calls).map(async ([name, call]) => [name, await outcome(call)] as const),
        ),
      );

      expect(Object.entries(codes).filter(([, code]) => code !== "invalid_args")).toStrictEqual([]);

      expect(
        await outcome(
          direct(fixture.member, "query", "titles:list", {
            profileId: fixture.memberProfile,
            limit: Number.NaN,
          }),
        ),
      ).toBe("succeeded");

      await expect(
        direct(fixture.owner, "mutation", "libraries:create", {
          name: `Bounds ${id}`,
          kind: "movies",
          roots: ["   "],
        }),
      ).rejects.toMatchObject({
        data: { code: "invalid_args", message: "Folders must be absolute paths: " },
      });
      await run(fixture.member, "playback.endSession", {
        sessionId: started.sessionId,
        positionMs: ms(0),
      });
    });
  });

  describe("metadata overrides", () => {
    it("keeps a hand-picked match through a later refresh", async () => {
      const name = `Hand Matched ${TOKEN}`;

      const item = scanned(
        `/stack-${id}/open/hand-matched.mp4`,
        {
          kind: "movie",
          name,
          ageRating: 0,
        },
        null,
      );

      await service(fixture.mediaService, "mediaService.upsertScanned", {
        libraryId: fixture.openLibrary,
        items: [item],
      });

      const titleId = (await titleNamed(fixture.owner, fixture.ownerProfile, name)).id;

      const runMetadataJob = async (jobId: JobId) => {
        const workerId = `metadata-${id}`;

        await service(fixture.mediaService, "mediaService.claimJob", {
          jobId,
          workerId,
          leaseMs: 60_000,
        });
        await service(fixture.mediaService, "mediaService.applyMetadata", {
          jobId,
          workerId,
          titleId,
          title: { ...item.title, matchStatus: "matched" },
          episodes: [],
        });
        await service(fixture.mediaService, "mediaService.completeJob", { jobId, workerId });
      };

      const matchStatus = async () =>
        (await run(fixture.owner, "titles.get", { profileId: fixture.ownerProfile, titleId }))
          .matchStatus;

      const fixed = await run(fixture.owner, "metadata.fixMatch", {
        titleId,
        provider: "tmdb",
        providerId: `603${id}`,
      });

      await runMetadataJob(fixed.jobId);
      expect(await matchStatus()).toBe("manual");

      await runMetadataJob((await run(fixture.owner, "metadata.refresh", { titleId })).jobId);
      expect(await matchStatus()).toBe("manual");
    });

    it("sorts title lists by a sort name an admin set", async () => {
      const moviesByName = async () =>
        (
          await run(fixture.owner, "titles.list", {
            profileId: fixture.ownerProfile,
            libraryId: fixture.openLibrary,
            kind: "movie",
            sort: "name",
          })
        ).items.map((title) => title.id);

      await run(fixture.owner, "metadata.edit", {
        titleId: fixture.titles.unrated,
        set: { sortName: `!First ${TOKEN}` },
      });
      expect((await moviesByName())[0]).toBe(fixture.titles.unrated);

      await run(fixture.owner, "metadata.edit", {
        titleId: fixture.titles.unrated,
        set: { name: `!Renamed ${TOKEN}` },
        clear: ["sortName"],
      });
      expect((await moviesByName())[0]).not.toBe(fixture.titles.unrated);

      await run(fixture.owner, "metadata.edit", {
        titleId: fixture.titles.unrated,
        set: {},
        clear: ["name"],
      });
    });
  });

  describe("room links", () => {
    it("shows a room to non-members only through a profile that may see it, and without members", async () => {
      const hostDevice = device("link-host");

      const room = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: hostDevice,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      expect(await outcome(run(fixture.member, "rooms.get", { roomId: room.id }))).toBe(
        "not_found",
      );
      expect(
        await outcome(
          run(fixture.member, "rooms.get", { roomId: room.id, profileId: fixture.ownerProfile }),
        ),
      ).toBe("not_found");

      const preview = await run(fixture.member, "rooms.get", {
        roomId: room.id,
        profileId: fixture.memberProfile,
      });

      expect(preview.members).toStrictEqual([]);
      expect(preview.title.id).toBe(fixture.titles.allAges);

      const guestDevice = device("link-guest");

      await run(fixture.member, "rooms.join", {
        roomId: room.id,
        profileId: fixture.kidsProfile,
        deviceId: guestDevice,
      });
      expect((await run(fixture.member, "rooms.get", { roomId: room.id })).members).toHaveLength(2);

      await run(fixture.owner, "rooms.setMedia", {
        roomId: room.id,
        deviceId: hostDevice,
        revision: (await run(fixture.owner, "rooms.get", { roomId: room.id })).clock.revision,
        titleId: fixture.titles.adult,
      });
      expect(await outcome(run(fixture.member, "rooms.get", { roomId: room.id }))).toBe(
        "not_found",
      );
      expect(
        await outcome(
          run(fixture.member, "rooms.get", { roomId: room.id, profileId: fixture.kidsProfile }),
        ),
      ).toBe("not_found");
      expect(await run(fixture.member, "rooms.current", { deviceId: guestDevice })).toBeNull();

      await run(fixture.member, "rooms.leave", { roomId: room.id, deviceId: guestDevice });
      await run(fixture.owner, "rooms.end", { roomId: room.id, deviceId: hostDevice });
    });
  });

  describe("room membership and PINs", () => {
    it("moves a device that joins another room out of the one it was in", async () => {
      const firstHost = device("first-host");
      const secondHost = device("second-host");
      const guestDevice = device("hopping-guest");

      const first = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: firstHost,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      const second = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: secondHost,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      const joinWithGuest = (roomId: RoomId) =>
        run(fixture.member, "rooms.join", {
          roomId,
          profileId: fixture.memberProfile,
          deviceId: guestDevice,
        });

      await joinWithGuest(first.id);
      await joinWithGuest(second.id);

      expect((await run(fixture.member, "rooms.current", { deviceId: guestDevice }))?.id).toBe(
        second.id,
      );
      expect((await run(fixture.owner, "rooms.get", { roomId: first.id })).members).toHaveLength(1);

      await run(fixture.owner, "rooms.join", {
        roomId: second.id,
        profileId: fixture.ownerProfile,
        deviceId: firstHost,
      });
      expect(rowOf("rooms", firstHost).status).toBe("ended");

      await run(fixture.member, "rooms.leave", { roomId: second.id, deviceId: guestDevice });
      await run(fixture.owner, "rooms.end", { roomId: second.id, deviceId: secondHost });
    });

    it("hides a room joined with a PIN profile from sessions that have not entered the PIN", async () => {
      const hostDevice = device("pin-host");
      const guestDevice = device("pin-guest");

      const room = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: hostDevice,
        titleId: fixture.titles.allAges,
        positionMs: ms(0),
      });

      const guarded = await run(fixture.member, "profiles.create", {
        name: `Guarded ${id}`,
        avatar: "owl",
        kids: false,
      });

      await run(fixture.member, "profiles.setPin", { profileId: guarded.id, pin: "1357" });
      await run(fixture.member, "rooms.join", {
        roomId: room.id,
        profileId: guarded.id,
        deviceId: guestDevice,
      });
      expect((await run(fixture.member, "rooms.get", { roomId: room.id })).members).toHaveLength(2);

      const fresh = await signIn(url, password(fixture.memberEmail, "signIn"));

      expect(await outcome(run(fresh, "rooms.get", { roomId: room.id }))).toBe("not_found");
      expect(await run(fresh, "rooms.current", { deviceId: guestDevice })).toBeNull();

      await run(fresh, "profiles.unlock", { profileId: guarded.id, pin: "1357" });
      expect((await run(fresh, "rooms.get", { roomId: room.id })).members).toHaveLength(2);

      await run(fixture.member, "rooms.leave", { roomId: room.id, deviceId: guestDevice });
      await run(fixture.owner, "rooms.end", { roomId: room.id, deviceId: hostDevice });
    });
  });

  describe("title pages", () => {
    it("fills each page for a limited profile and reads a library through its own index", async () => {
      const created = await run(fixture.owner, "libraries.create", {
        name: `Paging ${id}`,
        kind: "movies",
        roots: [`/stack-${id}/paging`],
      });

      const movies = [
        ["A", 0],
        ["B", 17],
        ["C", 17],
        ["D", 0],
        ["E", 17],
        ["F", 17],
        ["G", 17],
        ["H", 0],
        ["I", 17],
      ] as const;

      await service(fixture.mediaService, "mediaService.upsertScanned", {
        libraryId: created.libraryId,
        items: movies.map(([letter, ageRating]) =>
          scanned(
            `/stack-${id}/paging/${letter}.mp4`,
            { kind: "movie", name: `Paging ${letter} ${TOKEN}`, ageRating },
            null,
          ),
        ),
      });

      const pages = async (
        session: Session,
        profileId: ProfileId,
        sort: "name" | "added" | "year",
      ): Promise<ReadonlyArray<ReadonlyArray<string>>> => {
        const read = async (
          cursor: string | null,
          found: ReadonlyArray<ReadonlyArray<string>>,
        ): Promise<ReadonlyArray<ReadonlyArray<string>>> => {
          const args = { profileId, libraryId: created.libraryId, sort, limit: 2 };

          const page = await run(
            session,
            "titles.list",
            cursor === null ? args : { ...args, cursor },
          );

          const all = [...found, page.items.map((title) => title.name)];

          return page.nextCursor === null || all.length > 20 ? all : read(page.nextCursor, all);
        };

        return read(null, []);
      };

      expect(await pages(fixture.member, fixture.kidsProfile, "name")).toStrictEqual([
        [`Paging A ${TOKEN}`, `Paging D ${TOKEN}`],
        [`Paging H ${TOKEN}`],
      ]);

      const everyOrder = await Promise.all(
        (["name", "added", "year"] as const).map(async (sort) =>
          (await pages(fixture.owner, fixture.ownerProfile, sort)).flat().toSorted(),
        ),
      );

      const all = movies.map(([letter]) => `Paging ${letter} ${TOKEN}`).toSorted();

      expect(everyOrder).toStrictEqual([all, all, all]);

      await run(fixture.owner, "libraries.remove", { libraryId: created.libraryId });
    });

    it("pages a genre and the metadata filters the same way, full for a limited profile", async () => {
      const created = await run(fixture.owner, "libraries.create", {
        name: `Genre paging ${id}`,
        kind: "movies",
        roots: [`/stack-${id}/genre-paging`],
      });

      const genre = `Paging${id}`;

      const movies = [
        ["A", 0, true, 1990, "One", 8],
        ["B", 17, true, 1991, "One", 7],
        ["C", 0, false, 1992, "One", 9],
        ["D", 0, true, 1993, "Two", 6],
        ["E", 17, true, 1994, "One", 8.5],
        ["F", 0, true, 1995, "One", 8.2],
        ["G", 17, false, 1996, "Two", 5],
        ["H", 0, true, 1997, "One", 7.5],
        ["I", 0, true, 1998, "One", 9.1],
      ] as const;

      await service(fixture.mediaService, "mediaService.upsertScanned", {
        libraryId: created.libraryId,
        items: movies.map(([letter, ageRating, inGenre, year, studio, score]) =>
          scanned(
            `/stack-${id}/genre-paging/${letter}.mp4`,
            { kind: "movie", name: `Genre ${letter} ${TOKEN}`, ageRating },
            null,
            {
              title: {
                year,
                genres: inGenre ? ["Drama", genre] : ["Drama"],
                studios: [`Studio ${studio} ${id}`],
                ratings: {
                  tmdb: { value: score, votes: 100 },
                  imdb: null,
                  rottenTomatoes: null,
                  metacritic: null,
                },
              },
            },
          ),
        ),
      });

      expect(
        await filteredPages(fixture.member, fixture.kidsProfile, "name", {
          genre: genre.toUpperCase(),
        }),
      ).toStrictEqual([genreNames("A", "D"), genreNames("F", "H"), genreNames("I")]);

      const orders = await Promise.all(
        (["added", "year"] as const).map((sort) =>
          filteredPages(fixture.member, fixture.kidsProfile, sort, { genre }),
        ),
      );

      for (const order of orders) {
        expect(order.map((page) => page.length)).toStrictEqual([2, 2, 1]);
        expect(order.flat().toSorted()).toStrictEqual(
          [...genreNames("A", "D", "F", "H", "I")].toSorted(),
        );
      }

      expect((orders[1] ?? []).flat()).toStrictEqual(genreNames("I", "H", "F", "D", "A"));

      const narrowed = {
        genre,
        yearFrom: 1991,
        yearTo: 1997,
        studio: `studio one ${id}`,
        minRating: 7.5,
        libraryId: created.libraryId,
      };

      expect(
        await filteredPages(fixture.owner, fixture.ownerProfile, "name", narrowed),
      ).toStrictEqual([genreNames("E", "F"), genreNames("H")]);

      expect(
        (
          await filteredPages(fixture.owner, fixture.ownerProfile, "year", {
            yearFrom: 1991,
            yearTo: 1997,
            minRating: 7.5,
            libraryId: created.libraryId,
          })
        ).flat(),
      ).toStrictEqual(genreNames("H", "F", "E", "C"));

      expect(
        await filteredPages(fixture.owner, fixture.ownerProfile, "name", {
          genre,
          libraryId: fixture.openLibrary,
        }),
      ).toStrictEqual([[]]);

      await run(fixture.owner, "libraries.remove", { libraryId: created.libraryId });
    });
  });

  describe("removing a library", () => {
    it("ends its playback and rooms and purges its collection memberships", async () => {
      const created = await run(fixture.owner, "libraries.create", {
        name: `Doomed ${id}`,
        kind: "movies",
        roots: [`/stack-${id}/doomed`],
      });

      await service(fixture.mediaService, "mediaService.upsertScanned", {
        libraryId: created.libraryId,
        items: [
          scanned(
            `/stack-${id}/doomed/doomed.mp4`,
            { kind: "movie", name: `Doomed ${TOKEN}`, ageRating: 0 },
            null,
          ),
        ],
      });

      const titleId = (await titleNamed(fixture.owner, fixture.ownerProfile, `Doomed ${TOKEN}`)).id;

      const owner = (await run(fixture.owner, "account.viewer", {})).user.id;
      const { jobId, worker } = await claimMigration(fixture, owner, `server-doomed-${id}`);

      await service(fixture.mediaService, "migrationService.importCollections", {
        jobId,
        workerId: worker,
        items: [
          { sourceKey: `doomed:${id}`, name: `Doomed ${id}`, sortName: null, titleIds: [titleId] },
        ],
      });
      await service(fixture.mediaService, "mediaService.completeJob", { jobId, workerId: worker });

      const started = await run(fixture.member, "playback.createSession", {
        profileId: fixture.memberProfile,
        deviceId: device("doomed"),
        titleId,
      });

      const hostDevice = device("doomed-host");

      const room = await run(fixture.owner, "rooms.create", {
        profileId: fixture.ownerProfile,
        deviceId: hostDevice,
        titleId,
        positionMs: ms(0),
      });

      await run(fixture.owner, "libraries.remove", { libraryId: created.libraryId });

      await expect
        .poll(
          () =>
            outcome(run(fixture.member, "playback.renewToken", { sessionId: started.sessionId })),
          { timeout: 30_000 },
        )
        .toBe("conflict");
      await expect.poll(() => rowOf("rooms", room.id).status, { timeout: 30_000 }).toBe("ended");

      const memberships = async () =>
        tableLines("collectionItems").filter((line) => line.includes(titleId)).length;

      const until = Date.now() + 30_000;

      const purged = async (): Promise<number> => {
        const left = await memberships();

        if (left === 0 || Date.now() > until) return left;
        await sleep(1_000);

        return purged();
      };

      expect(await purged()).toBe(0);
    }, 60_000);
  });

  describe("invites", () => {
    it("refuses expired and revoked invites", async () => {
      const ownerId = (await run(fixture.owner, "account.viewer", {})).user.id;
      const expiredCode = `expired-invite-${id}`;

      importDocuments("invites", [
        JSON.stringify({
          codeHash: sha256(expiredCode),
          email: null,
          role: "member",
          createdBy: ownerId,
          expiresAt: Date.now() - 1_000,
        }),
      ]);

      expect(await run(anonymous(url), "invites.lookup", { code: expiredCode })).toMatchObject({
        state: "expired",
      });
      expect(
        await outcome(signIn(url, password(`late-${id}@movies.test`, "signUp", expiredCode))),
      ).not.toBe("succeeded");

      const created = await run(fixture.owner, "invites.create", { role: "member" });

      await run(fixture.owner, "invites.revoke", { inviteId: created.invite.id });
      expect(await run(anonymous(url), "invites.lookup", { code: created.code })).toStrictEqual({
        state: "invalid",
      });
      expect(
        (await run(fixture.owner, "invites.list", {})).find(
          (invite) => invite.id === created.invite.id,
        )?.state,
      ).toBe("revoked");
      expect(
        await outcome(signIn(url, password(`revoked-${id}@movies.test`, "signUp", created.code))),
      ).not.toBe("succeeded");
    });
  });

  describe("history", () => {
    it("lists what a profile played, newest first", async () => {
      const email = `history-${id}@movies.test`;
      const viewer = await inviteMember(fixture.owner, email);
      const profileId = await firstProfile(viewer);

      const play = async (titleId: TitleId) => {
        const started = await run(viewer, "playback.createSession", {
          profileId,
          deviceId: device(`history-${titleId}`),
          titleId,
        });

        await run(viewer, "playback.reportProgress", {
          sessionId: started.sessionId,
          positionMs: ms(60_000),
          event: "pause",
        });
      };

      await play(fixture.titles.allAges);
      await play(fixture.titles.adult);

      const page = await run(viewer, "history.list", { profileId, limit: 10 });

      expect(page.items.map((entry) => entry.title.id)).toStrictEqual([
        fixture.titles.adult,
        fixture.titles.allAges,
      ]);
      expect(page.items[0]?.progress.positionMs).toBe(60_000);
    });
  });

  describe("scheduled upkeep", () => {
    it("fails, rather than takes over, a lapsed job that used its last attempt", async () => {
      const lapsedOwner = `lapsed-worker-${id}`;
      const longAgo = Date.now() - 60 * 60 * 1000;

      importDocuments("jobs", [
        JSON.stringify({
          kind: "metadata",
          status: "running",
          payload: { kind: "metadata", titleId: fixture.titles.unrated, match: null },
          progress: { done: 0, total: null, message: null },
          error: null,
          requestedBy: null,
          attempts: 5,
          leaseOwner: lapsedOwner,
          leaseExpiresAt: longAgo,
          startedAt: longAgo,
          finishedAt: null,
        }),
      ]);

      const jobId = JobIdSchema.make(
        idOf(tableLines("jobs").find((line) => line.includes(lapsedOwner)) ?? "{}"),
      );

      expect(
        await service(fixture.mediaService, "mediaService.claimJob", {
          jobId,
          workerId: `taker-${id}`,
          leaseMs: 5_000,
        }),
      ).toBeNull();
      expect(await run(fixture.owner, "jobs.get", { jobId })).toMatchObject({ status: "failed" });
    });

    it("returns lapsed leases, ends idle playback, expires device codes, and sweeps rooms", async () => {
      const { jobId } = await run(fixture.owner, "metadata.refresh", {
        titleId: fixture.titles.unrated,
      });

      await service(fixture.mediaService, "mediaService.claimJob", {
        jobId,
        workerId: `lapsing-${id}`,
        leaseMs: 5_000,
      });

      const viewer = await run(fixture.member, "account.viewer", {});
      const file = await fileAt(fixture, `/stack-${id}/open/all-ages.mp4`);
      const idleDevice = `idle-${id}`;
      const codeHash = sha256(`lapsed-code-${id}`);
      const longAgo = Date.now() - 2 * 60 * 60 * 1000;

      importDocuments("playbackSessions", [
        JSON.stringify({
          userId: viewer.user.id,
          profileId: fixture.memberProfile,
          authSessionId: viewer.sessionId,
          deviceId: idleDevice,
          deviceName: null,
          titleId: fixture.titles.allAges,
          episodeId: null,
          fileId: file.fileId,
          roomId: null,
          mode: null,
          status: "active",
          state: "playing",
          positionMs: 0,
          startedAt: longAgo,
          lastReportAt: longAgo,
          endedAt: null,
        }),
      ]);
      importDocuments("deviceCodes", [
        JSON.stringify({
          deviceCodeHash: codeHash,
          userCode: `YYYY-${id
            .toUpperCase()
            .replaceAll(/[^A-Z]/gu, "C")
            .padEnd(4, "C")
            .slice(0, 4)}`,
          clientName: `Lapsed ${id}`,
          status: "pending",
          expiresAt: Date.now() - 1_000,
        }),
      ]);
      importDocuments("rooms", [
        JSON.stringify({
          titleId: fixture.titles.allAges,
          episodeId: null,
          fileId: file.fileId,
          hostUserId: viewer.user.id,
          hostProfileId: fixture.memberProfile,
          hostDeviceId: `abandoned-${id}`,
          status: "playing",
          positionAtAnchorMs: 0,
          anchorServerTime: longAgo,
          playbackRate: 1,
          revision: 3,
          hostLastSeenAt: longAgo,
          hostAway: false,
        }),
      ]);

      await sleep(6_000);

      for (const cron of [
        "maintenance:releaseExpiredLeases",
        "maintenance:endIdlePlayback",
        "maintenance:expireDeviceCodes",
        "maintenance:sweepRooms",
      ]) {
        runInternal(cron);
      }

      expect((await run(fixture.owner, "jobs.get", { jobId })).status).toBe("pending");

      expect(rowOf("playbackSessions", idleDevice).status).toBe("ended");
      expect(rowOf("deviceCodes", codeHash).status).toBe("expired");
      expect(rowOf("rooms", `abandoned-${id}`).status).toBe("ended");

      await run(fixture.owner, "jobs.cancel", { jobId });
    }, 60_000);
  });

  describe("every public function", () => {
    const CONVEX_AUTH: ReadonlySet<string> = new Set([
      "auth:signIn",
      "auth:signOut",
      "auth:isAuthenticated",
    ]);

    const scopeOf = new Map<string, CommandAccess>(
      [...Object.values(commands), ...Object.values(mediaServiceFunctions)].flatMap(
        (command: AnyCommand) =>
          command.kind === "media" ? [] : [[command.function, command.scope] as const],
      ),
    );

    let functions: ReadonlyArray<PublicFunction>;
    let ids: ReadonlyMap<string, string>;

    beforeAll(async () => {
      if ((await run(fixture.owner, "backups.list", {})).length === 0) {
        await service(fixture.mediaService, "mediaService.syncBackups", {
          archives: [
            {
              fileName: `movies-manual-${id}.zip`,
              sizeBytes: Bytes.make(1),
              trigger: "manual",
              takenAt: EpochMillis.make(Date.now()),
            },
          ],
        });
      }

      functions = await publicFunctions();
      ids = sampleIds(functions.flatMap((fn) => tablesIn(fn.args)));
    });

    const call = async (session: Session, fn: PublicFunction): Promise<void> => {
      const args = fn.args === null ? {} : toArgs(sampleValue(fn.args, ids));

      await Match.value(fn.kind).pipe(
        Match.when("query", () =>
          session.client.query(makeFunctionReference<"query">(fn.path), args),
        ),
        Match.when("mutation", () =>
          session.client.mutation(makeFunctionReference<"mutation">(fn.path), args),
        ),
        Match.when("action", () =>
          session.client.action(makeFunctionReference<"action">(fn.path), args),
        ),
        Match.exhaustive,
      );
    };

    const outcomesFor = async (session: Session, refused: (access: CommandAccess) => boolean) =>
      Promise.all(
        functions.flatMap((fn) => {
          const access = scopeOf.get(fn.path);

          return access === undefined || !refused(access)
            ? []
            : [outcome(call(session, fn)).then((code) => ({ path: fn.path, code }))];
        }),
      );

    it("finds every public function in the registry, except Convex Auth's", () => {
      expect(functions.length).toBeGreaterThan(100);
      expect(
        functions.flatMap((fn) =>
          scopeOf.has(fn.path) || CONVEX_AUTH.has(fn.path) ? [] : [fn.path],
        ),
      ).toStrictEqual([]);
    });

    it("lets anonymous callers reach only the public allowlist", async () => {
      expect(
        functions.flatMap((fn) => (scopeOf.get(fn.path) === "public" ? [fn.path] : [])).toSorted(),
      ).toStrictEqual([
        "deviceAuth:request",
        "deviceAuth:status",
        "invites:lookup",
        "setup:status",
      ]);

      const results = await outcomesFor(anonymous(url), (access) => access !== "public");

      expect(results.filter((result) => result.code !== "unauthenticated")).toStrictEqual([]);
    });

    it.each([
      { who: "the media service", session: (set: Fixture) => set.mediaService },
      { who: "a member", session: (set: Fixture) => set.member },
      { who: "a read-only key", session: (set: Fixture) => set.readKey },
    ])("refuses $who every scope its session lacks", async ({ session }) => {
      const caller = session(fixture);
      const viewer = await run(caller, "account.viewer", {});
      const held = new Set<CommandAccess>(["public", "authenticated", ...viewer.scopes]);
      const results = await outcomesFor(caller, (access) => !held.has(access));

      expect(results.length).toBeGreaterThan(10);
      expect(results.filter((result) => result.code !== "forbidden")).toStrictEqual([]);
    });
  });
});

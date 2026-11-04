import {
  AWAY_PRESENCE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HOST_ABANDON_TIMEOUT_MS,
  HOST_PRESENCE_TIMEOUT_MS,
  HOST_REANCHOR_THRESHOLD_MS,
  MEMBER_PRESENCE_TIMEOUT_MS,
  NEXT_EPISODE_COUNTDOWN_MS,
  PLAYER_SILENCE_MS,
  UNTIMED_HOST_REANCHOR_THRESHOLD_MS,
} from "@media/contracts/clock";
import type { AnyCommand } from "@media/contracts/command";
import { commands } from "@media/contracts/commands";
import { KIDS_DEFAULT_MAX_AGE } from "@media/contracts/content-rating";
import { DeviceId } from "@media/contracts/ids";
import { mediaServiceFunctions } from "@media/contracts/media-service";
import { LibraryRoot } from "@media/contracts/models/catalog";
import { NewPassword } from "@media/contracts/models/account";
import { DisplayName } from "@media/contracts/models/common";
import { BACKUP_SYNC_LIMIT } from "@media/contracts/models/jobs";
import {
  COLLECTION_BATCH_LIMIT,
  COLLECTION_MEMBER_BATCH_LIMIT,
} from "@media/contracts/models/migration-service";
import { AvatarKey } from "@media/contracts/models/profiles";
import { SCAN_BATCH_LIMIT } from "@media/contracts/models/scan";
import { Milliseconds } from "@media/contracts/units";
import {
  PLAYBACK_TOKEN_LIFETIME_MS,
  PLAYBACK_TOKEN_TEST_VECTORS,
} from "@media/contracts/playback-token";
import { YOUTUBE_KEY_PATTERN } from "@media/contracts/models/catalog";
import { Role, roleScopes } from "@media/contracts/scopes";
import { Predicate, Schema } from "effect";
import { describe, expect, it } from "vitest";

import * as account from "../convex/account";
import * as apiKeys from "../convex/apiKeys";
import * as authParams from "../convex/authParams";
import * as backups from "../convex/backups";
import * as collections from "../convex/collections";
import * as deviceAuth from "../convex/deviceAuth";
import * as downloads from "../convex/downloads";
import * as history from "../convex/history";
import * as invites from "../convex/invites";
import * as jobs from "../convex/jobs";
import * as libraries from "../convex/libraries";
import * as maintenance from "../convex/maintenance";
import * as mediaService from "../convex/mediaService";
import * as metadata from "../convex/metadata";
import * as migration from "../convex/migration";
import * as migrationService from "../convex/migrationService";
import * as myList from "../convex/myList";
import * as people from "../convex/people";
import * as playback from "../convex/playback";
import * as profiles from "../convex/profiles";
import * as rooms from "../convex/rooms";
import * as sessions from "../convex/sessions";
import * as setup from "../convex/setup";
import * as titles from "../convex/titles";
import * as users from "../convex/users";
import * as bounds from "../convex/lib/bounds";
import * as convexClock from "../convex/lib/roomClock";
import {
  PLAYBACK_TOKEN_LIFETIME_MS as CONVEX_TOKEN_LIFETIME_MS,
  signPlaybackToken,
} from "../convex/lib/playbackToken";
import { YOUTUBE_KEY } from "../convex/lib/catalog";
import { ROLE_SCOPES } from "../convex/lib/scopes";
import type { ValidatorJson } from "./validator-json";
import { normalizeValidator, parseExportedValidator, validatorFromSchema } from "./validator-json";

const modules = {
  account,
  apiKeys,
  authParams,
  backups,
  collections,
  deviceAuth,
  downloads,
  history,
  invites,
  jobs,
  libraries,
  maintenance,
  mediaService,
  metadata,
  migration,
  migrationService,
  myList,
  people,
  playback,
  profiles,
  rooms,
  sessions,
  setup,
  titles,
  users,
};

interface RegisteredFunction {
  readonly kind: "query" | "mutation" | "action";
  readonly isPublic: boolean;
  readonly args: ValidatorJson | null;
  readonly returns: ValidatorJson | null;
}

type Modules = typeof modules;

type RegisteredExport = {
  [Name in keyof Modules]: Modules[Name][keyof Modules[Name]];
}[keyof Modules];

const isExporter = (value: unknown): value is () => string => Predicate.isFunction(value);

const exported = (registered: RegisteredExport, method: "exportArgs" | "exportReturns") => {
  if (!Predicate.hasProperty(registered, method) || !isExporter(registered[method])) {
    throw new Error(`Convex function has no ${method}`);
  }

  return parseExportedValidator(registered[method]());
};

const flag = (registered: RegisteredExport, name: "isQuery" | "isMutation" | "isPublic"): boolean =>
  Predicate.hasProperty(registered, name) && registered[name] === true;

const registry = new Map<string, RegisteredFunction>(
  Object.entries(modules).flatMap(([moduleName, module]) =>
    Object.entries<RegisteredExport>(module).map(
      ([exportName, registered]): [string, RegisteredFunction] => [
        `${moduleName}:${exportName}`,
        {
          kind: flag(registered, "isQuery")
            ? "query"
            : flag(registered, "isMutation")
              ? "mutation"
              : "action",
          isPublic: flag(registered, "isPublic"),
          args: exported(registered, "exportArgs"),
          returns: exported(registered, "exportReturns"),
        },
      ],
    ),
  ),
);

const convexCommands = [
  ...Object.entries(commands),
  ...Object.entries(mediaServiceFunctions),
].flatMap(([name, command]: [string, AnyCommand]) =>
  command.kind === "media" ? [] : [{ name, command }],
);

const text = (length: number, prefix = ""): string => prefix.padEnd(length, "x");

const folders = (count: number) => Array.from({ length: count }, (_, index) => `/f${index}`);

const normalized = (json: ValidatorJson | null | undefined) =>
  json === null || json === undefined ? null : normalizeValidator(json);

describe("registry and Convex functions", () => {
  it.each(convexCommands)("$name matches its Convex function", ({ command }) => {
    const registered = registry.get(command.function);

    expect(registered, `${command.function} is not exported`).toBeDefined();
    expect(registered?.kind).toBe(command.kind);
    expect(registered?.isPublic).toBe(true);
    expect(normalized(registered?.args)).toStrictEqual(
      normalized(validatorFromSchema(command.args.ast)),
    );
    expect(normalized(registered?.returns)).toStrictEqual(
      normalized(validatorFromSchema(command.result.ast)),
    );
  });

  it("lists every public Convex function in the registry", () => {
    const listed: ReadonlySet<string> = new Set(
      convexCommands.map(({ command }) => command.function),
    );

    const unlisted = [...registry.entries()].flatMap(([path, registered]) =>
      registered.isPublic && !listed.has(path) ? [path] : [],
    );

    expect(unlisted).toStrictEqual([]);
  });
});

describe("constants shared across the seam", () => {
  it("gives each role the same scopes", () => {
    for (const role of Role.literals) expect(ROLE_SCOPES[role]).toStrictEqual(roleScopes(role));
  });

  it("checks YouTube keys with the same pattern", () => {
    expect(YOUTUBE_KEY.source).toBe(YOUTUBE_KEY_PATTERN.source);
    expect(YOUTUBE_KEY.flags).toBe(YOUTUBE_KEY_PATTERN.flags);
  });

  it("uses the same room clock timings", () => {
    expect(convexClock.HOST_PRESENCE_TIMEOUT_MS).toBe(HOST_PRESENCE_TIMEOUT_MS);
    expect(convexClock.MEMBER_PRESENCE_TIMEOUT_MS).toBe(MEMBER_PRESENCE_TIMEOUT_MS);
    expect(convexClock.HOST_ABANDON_TIMEOUT_MS).toBe(HOST_ABANDON_TIMEOUT_MS);
    expect(convexClock.HOST_REANCHOR_THRESHOLD_MS).toBe(HOST_REANCHOR_THRESHOLD_MS);
    expect(convexClock.UNTIMED_HOST_REANCHOR_THRESHOLD_MS).toBe(UNTIMED_HOST_REANCHOR_THRESHOLD_MS);
    expect(convexClock.HEARTBEAT_INTERVAL_MS).toBe(HEARTBEAT_INTERVAL_MS);
    expect(convexClock.PLAYER_SILENCE_MS).toBe(PLAYER_SILENCE_MS);
    expect(convexClock.AWAY_PRESENCE_TIMEOUT_MS).toBe(AWAY_PRESENCE_TIMEOUT_MS);
    expect(convexClock.NEXT_EPISODE_COUNTDOWN_MS).toBe(NEXT_EPISODE_COUNTDOWN_MS);
  });

  it("uses the same kids default and batch limits", () => {
    expect(bounds.KIDS_DEFAULT_MAX_AGE).toBe(KIDS_DEFAULT_MAX_AGE);
    expect(bounds.BATCH_LIMIT).toBe(SCAN_BATCH_LIMIT);
    expect(bounds.BACKUP_SYNC_LIMIT).toBe(BACKUP_SYNC_LIMIT);
    expect(bounds.COLLECTION_BATCH_LIMIT).toBe(COLLECTION_BATCH_LIMIT);
    expect(bounds.COLLECTION_MEMBER_BATCH_LIMIT).toBe(COLLECTION_MEMBER_BATCH_LIMIT);
  });

  it("asks for new passwords as long as the contract does", () => {
    const accepts = Schema.is(NewPassword);

    expect(accepts(text(bounds.PASSWORD_MIN, ""))).toBe(true);
    expect(accepts(text(bounds.PASSWORD_MIN - 1, ""))).toBe(false);
  });

  it.each([
    { name: "display names", schema: DisplayName, max: bounds.DISPLAY_NAME_MAX, prefix: "" },
    { name: "avatar keys", schema: AvatarKey, max: bounds.AVATAR_KEY_MAX, prefix: "" },
    { name: "device IDs", schema: DeviceId, max: bounds.DEVICE_ID_MAX, prefix: "" },
    { name: "library folders", schema: LibraryRoot, max: bounds.LIBRARY_ROOT_MAX, prefix: "/" },
  ])("bounds $name as the contract does", ({ schema, max, prefix }) => {
    const accepts = Schema.is(schema);

    expect(accepts(text(max, prefix))).toBe(true);
    expect(accepts(text(max + 1, prefix))).toBe(false);
  });

  it("bounds library folder counts and milliseconds as the contract does", () => {
    const roots = Schema.is(commands["libraries.create"].args.fields.roots);

    expect(roots(folders(bounds.LIBRARY_ROOTS_MAX))).toBe(true);
    expect(roots(folders(bounds.LIBRARY_ROOTS_MAX + 1))).toBe(false);

    const milliseconds = Schema.is(Milliseconds);

    expect([0, 1.5, -1, Number.POSITIVE_INFINITY, Number.NaN].map(milliseconds)).toStrictEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("signs the shared playback token vector exactly", async () => {
    const { payload, token } = PLAYBACK_TOKEN_TEST_VECTORS.valid;

    expect(CONVEX_TOKEN_LIFETIME_MS).toBe(PLAYBACK_TOKEN_LIFETIME_MS);

    await expect(
      signPlaybackToken(PLAYBACK_TOKEN_TEST_VECTORS.secret, {
        sub: payload.sub,
        pid: payload.pid,
        fid: payload.fid,
        sid: payload.sid,
        iat: payload.iat,
        exp: payload.exp,
      }),
    ).resolves.toBe(token);
  });

  it("signs the shared download token vector exactly", async () => {
    const { payload, token } = PLAYBACK_TOKEN_TEST_VECTORS.download;

    await expect(
      signPlaybackToken(PLAYBACK_TOKEN_TEST_VECTORS.secret, {
        sub: payload.sub,
        pid: payload.pid,
        fid: payload.fid,
        sid: payload.sid,
        iat: payload.iat,
        exp: payload.exp,
        pur: payload.pur,
      }),
    ).resolves.toBe(token);
  });
});

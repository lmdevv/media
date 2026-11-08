import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { commands } from "@media/contracts/commands";
import { NotFound } from "@media/contracts/errors";
import { ApiKeyScope } from "@media/contracts/scopes";
import { Auth, DeviceLogin, MoviesClient } from "@media/sdk/effect";
import { Effect, Option, Redacted, Schema, Struct } from "effect";
import { renderUnicodeCompact } from "uqr";

import type { UsageError } from "./cli-errors";
import { LoginRefused } from "./cli-errors";
import type { StoredProfile } from "./config";
import {
  layerProfileStorage,
  loadConfig,
  normalizeUrl,
  isServerUrl,
  setDefaultProfile,
  updateProfile,
} from "./config";
import type { Invocation, ShortcutCommand } from "./invocation";
import {
  booleanFlag,
  encodeResult,
  readSecret,
  requirePositional,
  resultOutcome,
  stringFlag,
  textOutcome,
  usage,
} from "./invocation";
import { Output } from "./output";
import { connect, openSdk, storageFailure } from "./session";

const keepOtherServerProfile = (
  invocation: Invocation,
  server: Option.Option<string>,
): Effect.Effect<void, UsageError> => {
  const { target } = invocation;

  const other = Option.filter(
    target.shadowed,
    (profile) => !Option.exists(server, (url) => url === normalizeUrl(profile.convexUrl)),
  );

  return Option.match(other, {
    onNone: () => Effect.void,
    onSome: (profile) =>
      Effect.fail(
        usage(
          invocation,
          `The stored profile "${target.name}" is for ${profile.convexUrl}; pass --profile <new-name> to use ${Option.getOrElse(server, () => "another server")}`,
        ),
      ),
  });
};

const login: ShortcutCommand = {
  path: "login",
  options: {
    server: { type: "string" },
    "media-url": { type: "string" },
    "api-key": { type: "string" },
    email: { type: "string" },
    password: { type: "boolean" },
  },
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const { env, target, tokens } = invocation;

      const server = Option.map(
        Option.orElse(stringFlag(tokens, "server"), () => target.convexUrl),
        normalizeUrl,
      );

      if (Option.isNone(server) || !isServerUrl(server.value)) {
        return yield* usage(
          invocation,
          "login needs --server with the Convex URL, such as http://nas.tailnet.ts.net:8080/movies/convex",
        );
      }

      const mediaUrl = Option.orElse(
        Option.map(stringFlag(tokens, "media-url"), normalizeUrl),
        () => target.mediaUrl,
      );

      const apiKey = Option.orElse(Option.map(stringFlag(tokens, "api-key"), Redacted.make), () =>
        target.apiKeyFromEnvironment ? target.apiKey : Option.none(),
      );

      yield* keepOtherServerProfile(invocation, server);

      const previous = Option.filter(
        Option.orElse(target.stored, () => target.shadowed),
        (profile) => normalizeUrl(profile.convexUrl) === server.value,
      );

      const base: StoredProfile = {
        convexUrl: server.value,
        deviceId: Option.match(previous, {
          onNone: () => `cli-${randomUUID()}`,
          onSome: (profile) => profile.deviceId,
        }),
        ...Option.match(mediaUrl, { onNone: () => ({}), onSome: (url) => ({ mediaUrl: url }) }),
        ...Option.match(
          Option.flatMap(previous, (profile) => Option.fromNullishOr(profile.viewingProfileId)),
          { onNone: () => ({}), onSome: (viewingProfileId) => ({ viewingProfileId }) },
        ),
        ...Option.match(apiKey, {
          onNone: () => ({}),
          onSome: (key) => ({ apiKey: Redacted.value(key) }),
        }),
      };

      const { client, auth } = yield* openSdk(
        server.value,
        mediaUrl,
        layerProfileStorage(env.configPath, target.name, Option.some(base)),
        env.configPath,
      );

      const email = stringFlag(tokens, "email");

      const signIn = (credentials: Auth.Credentials) =>
        auth
          .signIn(credentials)
          .pipe(
            Effect.catchTag("TokenStorageError", (error) =>
              Effect.fail(storageFailure(env.configPath)(error)),
            ),
          );

      if (Option.isSome(apiKey)) {
        yield* signIn(Auth.Credentials.ApiKey({ key: apiKey.value }));
      } else if (Option.isSome(email) || booleanFlag(tokens, "password")) {
        if (Option.isNone(email)) return yield* usage(invocation, "--password needs --email");
        const password = yield* readSecret(invocation, "MEDIA_PASSWORD", "password");

        yield* signIn(
          Auth.Credentials.Password({
            flow: "signIn",
            email: email.value,
            password,
            name: Option.none(),
            inviteCode: Option.none(),
          }),
        );
      } else {
        const pending = yield* DeviceLogin.start(`media CLI on ${hostname()}`).pipe(
          Effect.provideService(Auth.Auth, auth),
          Effect.provideService(MoviesClient.MoviesClient, client),
        );

        if (invocation.format === "json") {
          yield* output.err(
            JSON.stringify({
              event: "device_code",
              userCode: pending.userCode,
              verificationUrl: pending.verificationUrl,
              expiresAt: pending.expiresAt,
            }),
          );
        } else {
          yield* output.err(
            [
              `Open ${pending.verificationUrl} on a signed-in device and confirm code ${pending.userCode}.`,
              "",
              renderUnicodeCompact(pending.verificationUrl),
              "Waiting for approval…",
            ].join("\n"),
          );
        }

        yield* pending.complete.pipe(
          Effect.catchTags({
            DeviceLoginRefused: (refused) =>
              Effect.fail(new LoginRefused({ message: refused.message })),
            TokenStorageError: (error) => Effect.fail(storageFailure(env.configPath)(error)),
          }),
        );
      }

      const viewer = yield* client.query("account.viewer", {});

      const viewingProfileId: Option.Option<string> =
        base.viewingProfileId !== undefined || !viewer.scopes.includes("read")
          ? Option.fromNullishOr(base.viewingProfileId)
          : Option.fromNullishOr((yield* client.query("profiles.list", {}))[0]?.id);

      yield* updateProfile(env.configPath, target.name, (profile) =>
        Option.some(
          Struct.assign(base, {
            ...Option.match(
              Option.flatMap(profile, (current) => Option.fromNullishOr(current.session)),
              { onNone: () => ({}), onSome: (session) => ({ session }) },
            ),
            ...Option.match(viewingProfileId, {
              onNone: () => ({}),
              onSome: (id) => ({ viewingProfileId: id }),
            }),
          }),
        ),
      );

      const config = yield* loadConfig(env.configPath);

      if (Option.isNone(Option.fromNullishOr(config.profiles[config.defaultProfile]))) {
        yield* setDefaultProfile(env.configPath, target.name);
      }

      const json = {
        server: server.value,
        profile: target.name,
        user: yield* encodeResult("account.viewer", commands["account.viewer"], viewer),
        viewingProfileId: Option.getOrNull(viewingProfileId),
      };

      return textOutcome(
        json,
        `Logged in to ${server.value} as ${viewer.user.email ?? viewer.user.name} (${viewer.user.role}, ${viewer.sessionKind}). Saved to ${env.configPath}.`,
      );
    }),
};

const logout: ShortcutCommand = {
  path: "logout",
  options: {},
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const { env, target } = invocation;

      yield* keepOtherServerProfile(invocation, target.convexUrl);

      const storedSession = Option.flatMap(target.stored, (profile) =>
        Option.fromNullishOr(profile.session),
      );

      if (Option.isSome(target.convexUrl) && Option.isSome(storedSession)) {
        const { auth } = yield* openSdk(
          target.convexUrl.value,
          target.mediaUrl,
          layerProfileStorage(env.configPath, target.name, Option.none()),
          env.configPath,
        );

        yield* auth.signOut.pipe(
          Effect.catchTag("TokenStorageError", (error) =>
            Effect.fail(storageFailure(env.configPath)(error)),
          ),
        );
      }

      yield* updateProfile(env.configPath, target.name, (profile) =>
        Option.map(profile, ({ apiKey: _apiKey, session: _session, ...rest }) => rest),
      );

      if (target.apiKeyFromEnvironment) {
        yield* output.err("MEDIA_API_KEY is still set in the environment and keeps working.");
      }

      return textOutcome({ ok: true }, "Logged out.");
    }),
};

const whoami: ShortcutCommand = {
  path: "whoami",
  options: {},
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const viewer = yield* connection.withSession(connection.client.query("account.viewer", {}));

      const json = {
        server: connection.convexUrl,
        profile: invocation.target.name,
        deviceId: connection.deviceId,
        viewingProfileId: Option.getOrNull(connection.viewingProfileId),
        viewer: yield* encodeResult("account.viewer", commands["account.viewer"], viewer),
      };

      return textOutcome(
        json,
        [
          `${viewer.user.email ?? viewer.user.name} (${viewer.user.role}) on ${connection.convexUrl}`,
          `session: ${viewer.sessionKind}, scopes ${viewer.scopes.join(", ")}`,
          `device: ${connection.deviceId}`,
          `viewing profile: ${Option.getOrElse(connection.viewingProfileId, () => "none")}`,
        ].join("\n"),
      );
    }),
};

const profilesUse: ShortcutCommand = {
  path: "profiles use",
  options: {},
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const wanted = yield* requirePositional(invocation, "a profile ID or name");
      const { target } = invocation;

      yield* keepOtherServerProfile(invocation, target.convexUrl);

      const connection = yield* connect(invocation.env, target, "required");
      const profiles = yield* connection.withSession(connection.client.query("profiles.list", {}));

      const profile = profiles.find(
        (candidate) =>
          candidate.id === wanted || candidate.name.toLowerCase() === wanted.toLowerCase(),
      );

      if (profile === undefined) {
        return yield* new NotFound({
          message: `No profile "${wanted}"; choose one of ${profiles.map((p) => `${p.name} (${p.id})`).join(", ")}`,
        });
      }

      yield* updateProfile(invocation.env.configPath, invocation.target.name, (stored) =>
        Option.some(
          Option.match(stored, {
            onSome: (current) => Struct.assign(current, { viewingProfileId: profile.id }),
            onNone: (): StoredProfile => ({
              convexUrl: connection.convexUrl,
              deviceId: connection.deviceId,
              viewingProfileId: profile.id,
              ...Option.match(connection.target.mediaUrl, {
                onNone: () => ({}),
                onSome: (mediaUrl) => ({ mediaUrl }),
              }),
            }),
          }),
        ),
      );

      return textOutcome(
        { viewingProfileId: profile.id, name: profile.name },
        `Commands now use the profile ${profile.name} (${profile.id}).`,
      );
    }),
};

const parseScopes = Schema.decodeUnknownOption(
  Schema.Array(ApiKeyScope).check(Schema.isMinLength(1)),
);

const keysCreate: ShortcutCommand = {
  path: "keys create",
  options: { scopes: { type: "string" }, "expires-in-days": { type: "string" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const name = yield* requirePositional(invocation, "a key name");

      const scopes = parseScopes(
        Option.getOrElse(stringFlag(invocation.tokens, "scopes"), () => "")
          .split(",")
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0),
      );

      if (Option.isNone(scopes)) {
        return yield* usage(
          invocation,
          "--scopes expects a comma list of read, play, manage, admin",
        );
      }

      const days = Option.map(stringFlag(invocation.tokens, "expires-in-days"), Number);

      if (Option.isSome(days) && !Number.isInteger(days.value)) {
        return yield* usage(invocation, "--expires-in-days expects a whole number of days");
      }

      const connection = yield* connect(invocation.env, invocation.target, "required");

      const created = yield* connection.withSession(
        connection.client.action("apiKeys.create", {
          name,
          scopes: scopes.value,
          ...Option.match(days, {
            onNone: () => ({}),
            onSome: (expiresInDays) => ({ expiresInDays }),
          }),
        }),
      );

      if (invocation.format === "table")
        yield* output.err("The secret is shown once; store it now.");

      return resultOutcome(
        commands["apiKeys.create"],
        yield* encodeResult("apiKeys.create", commands["apiKeys.create"], created),
      );
    }),
};

const keysList: ShortcutCommand = {
  path: "keys list",
  options: {},
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const keys = yield* connection.withSession(connection.client.query("apiKeys.list", {}));

      return resultOutcome(
        commands["apiKeys.list"],
        yield* encodeResult("apiKeys.list", commands["apiKeys.list"], keys),
      );
    }),
};

const keysRevoke: ShortcutCommand = {
  path: "keys revoke",
  options: {},
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const wanted = yield* requirePositional(invocation, "an API key ID or name");
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const keys = yield* connection.withSession(connection.client.query("apiKeys.list", {}));

      const matches = keys.filter(
        (key) => key.revokedAt === null && (key.id === wanted || key.name === wanted),
      );

      const [key] = matches;

      if (key === undefined) {
        return yield* new NotFound({
          message: `No active API key "${wanted}"; see media keys list`,
        });
      }

      if (matches.length > 1) {
        return yield* usage(invocation, `Several keys are named "${wanted}"; revoke one by ID`);
      }

      yield* connection.withSession(
        connection.client.mutate("apiKeys.revoke", { apiKeyId: key.id }),
      );

      return textOutcome({ ok: true, apiKeyId: key.id }, `Revoked ${key.name} (${key.id}).`);
    }),
};

/** The account shortcuts. */
export const accountCommands: ReadonlyArray<ShortcutCommand> = [
  login,
  logout,
  whoami,
  profilesUse,
  keysCreate,
  keysList,
  keysRevoke,
];

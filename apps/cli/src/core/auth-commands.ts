import { hostname } from "node:os";

import { Platform } from "@media/sdk/effect";
import { Effect, Option, Schema } from "effect";

import { LoginRefused } from "../cli-errors";
import { normalizeUrl, ServerUrl } from "../config";
import type { Invocation } from "../invocation";
import { booleanFlag, readSecret, stringFlag, textOutcome, usage } from "../invocation";
import { Output } from "../output";
import type { CoreShortcut } from "./command";
import { coreShortcut } from "./command";
import { coreTarget, openCore, storageFailure } from "./session";

const isServerUrl = Schema.is(ServerUrl);

/** The device sign-in's code, on stderr: one JSON line for agents, a sentence for people. */
const announceDevice = Effect.fn("Core.announceDevice")(function* (
  invocation: Invocation,
  pending: Platform.DeviceSignIn,
) {
  const output = yield* Output;
  const approve = `media auth device-codes approve --user-code ${pending.userCode} --scopes account`;

  yield* invocation.format === "json"
    ? output.err(
        JSON.stringify({
          event: "device_code",
          userCode: pending.userCode,
          expiresAt: pending.expiresAt,
          approve,
        }),
      )
    : output.err(
        [
          `Approve code ${pending.userCode} from a device signed in to this server:`,
          `  ${approve}`,
          "Add admin to --scopes to let this device run media admin. Waiting for approval…",
        ].join("\n"),
      );
});

const login = coreShortcut("auth", "login", {
  usage: "[--server <convex-url>] [--username <name> | --api-key]",
  summary:
    "Sign in to the core: a device code by default, which a signed-in device approves; --username with the password from stdin or MEDIA_PASSWORD; --api-key with the key from stdin or MEDIA_CORE_API_KEY",
  options: {
    server: { type: "string" },
    username: { type: "string" },
    "api-key": { type: "boolean" },
  },
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const { tokens } = invocation;
      const target = yield* coreTarget(invocation.env, invocation.target.name);

      const url = Option.orElse(
        Option.map(stringFlag(tokens, "server"), normalizeUrl),
        () => target.url,
      );

      if (Option.isNone(url) || !isServerUrl(url.value)) {
        return yield* usage(
          invocation,
          "auth login needs --server with the core's Convex URL, such as http://nas.tailnet.ts.net:3214",
        );
      }

      const username = stringFlag(tokens, "username");
      const withKey = booleanFlag(tokens, "api-key");

      if (withKey && Option.isSome(username)) {
        return yield* usage(invocation, "Pass --username or --api-key, not both");
      }

      const platform = yield* openCore({ ...target, storage: "file" }, url.value);
      const failStorage = storageFailure(target.path);

      if ((yield* platform.session.currentStatus) === "signedIn") {
        yield* platform.session.signOut.pipe(Effect.mapError(failStorage));
      }

      const signIn = (credentials: Platform.Credentials) =>
        platform.session
          .signIn(credentials)
          .pipe(Effect.catchTag("TokenStorageError", (error) => Effect.fail(failStorage(error))));

      if (withKey) {
        const key = yield* readSecret(invocation, "MEDIA_CORE_API_KEY", "API key");

        yield* signIn(Platform.Credentials.ApiKey({ key }));
      } else if (Option.isSome(username)) {
        const password = yield* readSecret(invocation, "MEDIA_PASSWORD", "password");

        yield* signIn(Platform.Credentials.Password({ username: username.value, password }));
      } else {
        const pending = yield* platform.session.startDeviceSignIn(`media CLI on ${hostname()}`);

        yield* announceDevice(invocation, pending);
        yield* pending.complete.pipe(
          Effect.catchTags({
            DeviceSignInRefused: (refused) =>
              Effect.fail(new LoginRefused({ message: refused.message })),
            TokenStorageError: (error) => Effect.fail(failStorage(error)),
          }),
        );
      }

      const session = yield* platform.core.auth.sessions.current();

      return textOutcome(
        {
          server: url.value,
          profile: target.profile,
          session: {
            userId: session.userId,
            username: session.username,
            role: session.role,
            sessionId: session.sessionId,
            kind: session.kind,
            scopes: [...session.scopes],
          },
        },
        `Signed in to ${url.value} as ${session.username} (${session.role}, ${session.kind}). Saved to ${target.path}.`,
      );
    }),
});

const logout = coreShortcut("auth", "logout", {
  usage: "",
  summary: "Sign out of the core and forget the session; the profile keeps its server",
  options: {},
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const target = yield* coreTarget(invocation.env, invocation.target.name);

      if (Option.isSome(target.url) && target.storage === "file") {
        const platform = yield* openCore(target, target.url.value);

        yield* platform.session.signOut.pipe(Effect.mapError(storageFailure(target.path)));
      }

      if (Option.isSome(target.apiKey)) {
        yield* output.err("MEDIA_CORE_API_KEY is still set in the environment and keeps working.");
      }

      return textOutcome(
        { server: Option.getOrNull(target.url), profile: target.profile, signedOut: true },
        Option.match(target.url, {
          onNone: () => "Not signed in to a core.",
          onSome: (url) => `Signed out of ${url}.`,
        }),
      );
    }),
});

/** The sign-in commands of the `auth` group. */
export const authCommands: ReadonlyArray<CoreShortcut> = [login, logout];

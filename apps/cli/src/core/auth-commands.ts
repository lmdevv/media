import { hostname } from "node:os";

import { Platform } from "@media/sdk/effect";
import { Effect, Option } from "effect";
import { renderUnicodeCompact } from "uqr";

import { LoginRefused } from "../cli-errors";
import type { Target } from "../config";
import {
  endSession,
  forgetSession,
  heldSession,
  isServerUrl,
  normalizeUrl,
  openForSignIn,
  retarget,
  storageFailure,
} from "../config";
import type { Invocation } from "../invocation";
import { booleanFlag, readSecret, stringFlag, textOutcome, usage } from "../invocation";
import { Output } from "../output";
import type { CoreShortcut } from "./command";
import { coreShortcut } from "./command";

const announceDevice = Effect.fn("Core.announceDevice")(function* (
  invocation: Invocation,
  server: Target,
  pending: Platform.DeviceSignIn,
) {
  const output = yield* Output;
  const approve = `media auth device-codes approve --user-code ${pending.userCode} --scopes account`;

  const verificationUrl = Option.map(
    server.mediaUrl,
    (url) => `${url}/device?code=${encodeURIComponent(pending.userCode)}`,
  );

  yield* invocation.format === "json"
    ? output.err(
        JSON.stringify({
          event: "device_code",
          userCode: pending.userCode,
          verificationUrl: Option.getOrNull(verificationUrl),
          expiresAt: pending.expiresAt,
          approve,
        }),
      )
    : output.err(
        [
          ...Option.match(verificationUrl, {
            onNone: () => [],
            onSome: (url) => [
              `Open ${url} on a signed-in device and confirm code ${pending.userCode}.`,
              "",
              renderUnicodeCompact(url),
              "Or approve it from a device signed in to this server:",
            ],
          }),
          `  ${approve}`,
          "Add admin to --scopes to let this device run media admin. Waiting for approval…",
        ].join("\n"),
      );
});

const login = coreShortcut("auth", "login", {
  usage: "[--server <core-url>] [--media-url <url>] [--username <name> | --api-key]",
  summary:
    "Sign in: a device code by default, which a signed-in device approves; --username with the password from stdin or MEDIA_PASSWORD; --api-key with the key from stdin or MEDIA_CORE_API_KEY. --media-url names the media server when it is not the core's address without /convex",
  options: {
    server: { type: "string" },
    "media-url": { type: "string" },
    username: { type: "string" },
    "api-key": { type: "boolean" },
  },
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const { target, tokens } = invocation;

      const url = Option.orElse(
        Option.map(stringFlag(tokens, "server"), normalizeUrl),
        () => target.url,
      );

      if (Option.isNone(url) || !isServerUrl(url.value)) {
        return yield* usage(
          invocation,
          "auth login needs --server with the core's URL, such as http://nas.tailnet.ts.net:8080/convex",
        );
      }

      const mediaUrl = Option.map(stringFlag(tokens, "media-url"), normalizeUrl);

      if (Option.isSome(mediaUrl) && !isServerUrl(mediaUrl.value)) {
        return yield* usage(invocation, `--media-url is not an http(s) URL: "${mediaUrl.value}"`);
      }

      const username = stringFlag(tokens, "username");
      const withKey = booleanFlag(tokens, "api-key");

      if (withKey && Option.isSome(username)) {
        return yield* usage(invocation, "Pass --username or --api-key, not both");
      }

      const previous = yield* heldSession(target);
      const server = yield* retarget(target, url.value, mediaUrl);
      const platform = yield* openForSignIn(server, url.value);
      const failStorage = storageFailure(target.path);

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

        yield* announceDevice(invocation, server, pending);
        yield* pending.complete.pipe(
          Effect.catchTags({
            DeviceSignInRefused: (refused) =>
              Effect.fail(new LoginRefused({ message: refused.message })),
            TokenStorageError: (error) => Effect.fail(failStorage(error)),
          }),
        );
      }

      if (Option.isSome(previous)) yield* endSession(target, previous.value);

      const session = yield* platform.core.auth.sessions.current();

      return textOutcome(
        {
          server: url.value,
          mediaUrl: Option.getOrNull(server.mediaUrl),
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
  summary: "Sign out and forget the session; the profile keeps its server",
  options: {},
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const { target } = invocation;
      const held = yield* heldSession(target);

      if (Option.isSome(held)) {
        yield* endSession(target, held.value);
        yield* forgetSession(target, held.value);
      }

      if (Option.isSome(target.apiKey)) {
        yield* output.err("MEDIA_CORE_API_KEY is still set in the environment and keeps working.");
      }

      return textOutcome(
        {
          server: Option.getOrNull(Option.map(held, (session) => session.server.url)),
          profile: target.profile,
          signedOut: Option.isSome(held),
        },
        Option.match(held, {
          onNone: () => `Profile ${target.profile} holds no session.`,
          onSome: (session) => `Signed out of ${session.server.url}.`,
        }),
      );
    }),
});

/** The sign-in commands of the `auth` group. */
export const authCommands: ReadonlyArray<CoreShortcut> = [login, logout];

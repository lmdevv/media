import type { DeviceCodeState } from "@media/contracts/models/account";
import type { EpochMillis } from "@media/contracts/units";
import { Clock, Duration, Effect, Option, Redacted, Schedule, Schema, Stream } from "effect";
import type { ManagedRuntime } from "effect";

import * as Auth from "./auth";
import { MoviesClient } from "./movies-client";
import type { CallError } from "./sdk-errors";
import { isTransient } from "./sdk-errors";
import type { TokenStorageError } from "./token-storage";

/** The device sign-in was denied, expired, or already used. Start a new one. */
export class DeviceLoginRefused extends Schema.TaggedError<DeviceLoginRefused>()(
  "DeviceLoginRefused",
  {
    state: Schema.Literals(["denied", "expired", "consumed"]),
    message: Schema.String,
  },
) {}

/** A pending device sign-in. */
export interface DeviceLogin {
  /** The short code the person types or confirms on the approval page. */
  readonly userCode: string;
  /** The approval page; render it as a QR code too. */
  readonly verificationUrl: string;
  /** When the server stops accepting approval; `complete` gives up shortly after. */
  readonly expiresAt: EpochMillis;
  /** Waits for approval, then signs this client in. */
  readonly complete: Effect.Effect<void, DeviceLoginRefused | CallError | TokenStorageError>;
}

const EXPIRY_GRACE_MS = 5_000;

const STATUS_RETRY_SPACING = Duration.seconds(2);

interface DecidedStatus {
  readonly state: Exclude<DeviceCodeState, "pending">;
}

const isDecided = (status: { readonly state: DeviceCodeState }): status is DecidedStatus =>
  status.state !== "pending";

/** Starts a device sign-in named `clientName`, as the approving person will see it. */
export const start: (
  clientName: string,
) => Effect.Effect<DeviceLogin, CallError, MoviesClient | Auth.Auth> = Effect.fn(
  "DeviceLogin.start",
)(function* (clientName: string) {
  const client = yield* MoviesClient;
  const auth = yield* Auth.Auth;
  const request = yield* client.action("deviceAuth.request", { clientName });
  const deviceCode = Redacted.make(request.deviceCode);

  const complete = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const waitMs = Math.max(0, request.expiresAt - now) + EXPIRY_GRACE_MS;

    const decided = yield* client
      .subscribe("deviceAuth.status", { deviceCode: Redacted.value(deviceCode) })
      .pipe(
        Stream.filter(isDecided),
        Stream.runHead,
        Effect.retry({ while: isTransient, schedule: Schedule.spaced(STATUS_RETRY_SPACING) }),
        Effect.timeoutOption(Duration.millis(waitMs)),
        Effect.map(Option.flatten),
      );

    const state = Option.match(decided, {
      onNone: () => "expired" as const,
      onSome: (status) => status.state,
    });

    if (state === "approved") {
      return yield* auth.signIn(Auth.Credentials.DeviceCode({ deviceCode }));
    }

    return yield* new DeviceLoginRefused({
      state,
      message: `Device sign-in ${state}: start a new sign-in`,
    });
  }).pipe(Effect.withSpan("DeviceLogin.complete"));

  const login: DeviceLogin = {
    userCode: request.userCode,
    verificationUrl: request.verificationUrl,
    expiresAt: request.expiresAt,
    complete,
  };

  return login;
});

/** A pending device sign-in for code that does not use Effect. */
export interface PendingDeviceLogin {
  /** The short code the person types or confirms on the approval page. */
  readonly userCode: string;
  /** The approval page; render it as a QR code too. */
  readonly verificationUrl: string;
  /** When the server stops accepting approval; `complete` gives up shortly after. */
  readonly expiresAt: EpochMillis;
  /**
   * Resolves once approved and signed in; rejects with `DeviceLoginRefused` when denied or expired.
   * Aborting `signal` stops waiting, so an abandoned code that is approved later signs nothing in;
   * the promise then rejects.
   */
  readonly complete: (signal?: AbortSignal) => Promise<void>;
}

/** Starts a device sign-in on `runtime`, for the Promise and React entry points. */
export const startOn = async (
  runtime: ManagedRuntime.ManagedRuntime<MoviesClient | Auth.Auth, unknown>,
  clientName: string,
): Promise<PendingDeviceLogin> => {
  const login = await runtime.runPromise(start(clientName));

  return {
    userCode: login.userCode,
    verificationUrl: login.verificationUrl,
    expiresAt: login.expiresAt,
    complete: (signal) => runtime.runPromise(login.complete, { signal }),
  };
};

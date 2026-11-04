import type { CommandError, RequestIdentity } from "@media/contracts/errors";
import { PlaybackApiError } from "@media/contracts/media-playback";
import type { CallError } from "@media/sdk/effect";
import { Match, Schema } from "effect";

/** The command line was wrong: an unknown command, a missing flag, or a value the schema rejects. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
  /** The command whose help explains the fix, such as `rooms pause`. */
  command: Schema.NullOr(Schema.String),
}) {}

/** Reading or writing the config file failed, or it holds something the CLI cannot read. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A job followed with `--wait` failed, was cancelled, or outlived `--timeout`. */
export class JobError extends Schema.TaggedError<JobError>()("JobError", {
  code: Schema.Literals(["job_failed", "job_cancelled", "timeout"]),
  jobId: Schema.String,
  message: Schema.String,
}) {}

/** The CLI is not signed in to any server yet. */
export class NotLoggedIn extends Schema.TaggedError<NotLoggedIn>()("NotLoggedIn", {
  message: Schema.String,
}) {}

/** A device sign-in was denied, expired, or already used. */
export class LoginRefused extends Schema.TaggedError<LoginRefused>()("LoginRefused", {
  message: Schema.String,
}) {}

/** An external program such as mpv could not be started. */
export class LaunchError extends Schema.TaggedError<LaunchError>()("LaunchError", {
  program: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * The media service refused to play. `error` is the playback API's tagged error, such as
 * `UnsupportedPlayback`; `recovery` is what a player does about it (`Playback.recoveryFor`).
 */
export class PlaybackRefused extends Schema.TaggedError<PlaybackRefused>()("PlaybackRefused", {
  error: PlaybackApiError,
  recovery: Schema.Literals([
    "reload-playlist",
    "renegotiate",
    "renew-token",
    "new-session",
    "retry-later",
    "unsupported",
    "fail",
  ]),
}) {
  override get message(): string {
    return `The media service refused to play: ${this.error.message}`;
  }
}

/** `media import` could not use the Jellyfin or Plex server; `reason` says why. */
export class MigrationSourceError extends Schema.TaggedError<MigrationSourceError>()(
  "MigrationSourceError",
  {
    reason: Schema.Literals([
      "unreachable",
      "auth_failed",
      "not_admin",
      "version_unsupported",
      "unexpected_response",
    ]),
    message: Schema.String,
  },
) {}

/** Every expected failure the CLI reports. */
export type CliError =
  | CallError
  | PlaybackRefused
  | UsageError
  | ConfigFileError
  | JobError
  | NotLoggedIn
  | LoginRefused
  | LaunchError
  | MigrationSourceError;

/** Process exit codes. Stable: agents branch on them. */
export const ExitCode = {
  ok: 0,
  failed: 1,
  usage: 2,
  unauthenticated: 3,
  forbidden: 4,
  notFound: 5,
  conflict: 6,
  expired: 7,
  rateLimited: 8,
  unavailable: 9,
  job: 10,
  source: 11,
} as const;

/** A process exit code. */
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * The stable `code` and readable `message` printed for an error, with the media service's
 * `requestId` when it answered the failed request.
 */
export interface ErrorReport extends RequestIdentity {
  readonly code: string;
  readonly message: string;
}

const commandCode: (error: CommandError) => string = Match.type<CommandError>().pipe(
  Match.tagsExhaustive({
    Unauthenticated: () => "unauthenticated",
    Forbidden: () => "forbidden",
    NotFound: () => "not_found",
    InvalidArgs: () => "invalid_args",
    Conflict: () => "conflict",
    Expired: () => "expired",
    StaleRevision: () => "stale_revision",
    RateLimited: () => "rate_limited",
    Internal: () => "internal",
  }),
);

const requestIdOf = (error: RequestIdentity): RequestIdentity =>
  error.requestId === undefined ? {} : { requestId: error.requestId };

const commandReport = (error: CommandError): ErrorReport => ({
  code: commandCode(error),
  message: error.message,
  ...requestIdOf(error),
});

/** Maps an error to its exit code. */
export const exitCodeOf: (error: CliError) => ExitCode = Match.type<CliError>().pipe(
  Match.tagsExhaustive({
    Unauthenticated: () => ExitCode.unauthenticated,
    NotLoggedIn: () => ExitCode.unauthenticated,
    LoginRefused: () => ExitCode.unauthenticated,
    Forbidden: () => ExitCode.forbidden,
    NotFound: () => ExitCode.notFound,
    InvalidArgs: () => ExitCode.usage,
    UsageError: () => ExitCode.usage,
    Conflict: () => ExitCode.conflict,
    StaleRevision: () => ExitCode.conflict,
    Expired: () => ExitCode.expired,
    RateLimited: () => ExitCode.rateLimited,
    TransportError: () => ExitCode.unavailable,
    JobError: () => ExitCode.job,
    Internal: () => ExitCode.failed,
    ProtocolError: () => ExitCode.failed,
    ConfigFileError: () => ExitCode.failed,
    LaunchError: () => ExitCode.failed,
    PlaybackRefused: (error) =>
      error.recovery === "retry-later" ? ExitCode.unavailable : ExitCode.failed,
    MigrationSourceError: () => ExitCode.source,
  }),
);

/** Maps an error to the `{ code, message, requestId }` report printed on stderr. */
export const reportOf: (error: CliError) => ErrorReport = Match.type<CliError>().pipe(
  Match.tagsExhaustive({
    Unauthenticated: commandReport,
    Forbidden: commandReport,
    NotFound: commandReport,
    InvalidArgs: commandReport,
    Conflict: commandReport,
    Expired: commandReport,
    StaleRevision: commandReport,
    RateLimited: commandReport,
    Internal: commandReport,
    TransportError: (error) => ({
      code: "unavailable",
      message: error.message,
      ...requestIdOf(error),
    }),
    ProtocolError: (error) => ({
      code: "protocol_error",
      message: error.message,
      ...requestIdOf(error),
    }),
    UsageError: (error) => ({ code: "usage", message: error.message }),
    ConfigFileError: (error) => ({ code: "config_error", message: error.message }),
    JobError: (error) => ({ code: error.code, message: error.message }),
    NotLoggedIn: (error) => ({ code: "not_logged_in", message: error.message }),
    LoginRefused: (error) => ({ code: "login_refused", message: error.message }),
    LaunchError: (error) => ({ code: "launch_failed", message: error.message }),
    PlaybackRefused: (error) => ({
      code: `playback_${error.recovery.replaceAll("-", "_")}`,
      message: error.message,
    }),
    MigrationSourceError: (error) => ({ code: `source_${error.reason}`, message: error.message }),
  }),
);

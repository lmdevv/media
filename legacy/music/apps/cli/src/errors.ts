import { Match, Schema } from "effect";

/** The command line was wrong: an unknown command, a missing flag, or a value the schema rejects. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
  /** The command whose help explains the fix, such as `playlists create`. */
  command: Schema.NullOr(Schema.String),
}) {}

/** The CLI has no usable credentials, the server rejected them, or the user lacks permission. */
export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  code: Schema.Literals(["not_logged_in", "invalid_key", "unauthenticated", "forbidden"]),
  message: Schema.String,
}) {}

/** The server ran the command and reported an expected failure such as `not_found`. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  code: Schema.String,
  message: Schema.String,
}) {}

/** The server could not be reached or answered with something other than a command result. */
export class ServerError extends Schema.TaggedError<ServerError>()("ServerError", {
  server: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Reading or writing the config directory failed. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Standard input could not be read, or the user cancelled a prompt. */
export class InputError extends Schema.TaggedError<InputError>()("InputError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A job waited on with `--wait` failed, was cancelled, or outlived `--timeout`. */
export class JobError extends Schema.TaggedError<JobError>()("JobError", {
  code: Schema.Literals(["job_failed", "job_cancelled", "timeout"]),
  jobId: Schema.String,
  message: Schema.String,
}) {}

/** Every expected failure the CLI reports. */
export type CliError =
  | UsageError
  | AuthError
  | CommandFailed
  | ServerError
  | ConfigFileError
  | InputError
  | JobError;

/** Process exit codes. Agents branch on these. */
export const ExitCode = { ok: 0, failed: 1, usage: 2, auth: 3 } as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** The stable `code` and readable `message` printed for an error. */
export interface ErrorReport {
  readonly code: string;
  readonly message: string;
}

/** Maps an error to its exit code. */
export const exitCodeOf: (error: CliError) => ExitCode = Match.type<CliError>().pipe(
  Match.tagsExhaustive({
    UsageError: () => ExitCode.usage,
    AuthError: () => ExitCode.auth,
    CommandFailed: () => ExitCode.failed,
    ServerError: () => ExitCode.failed,
    ConfigFileError: () => ExitCode.failed,
    InputError: () => ExitCode.failed,
    JobError: () => ExitCode.failed,
  }),
);

/** Maps an error to the `{ code, message }` pair printed on stderr. */
export const reportOf: (error: CliError) => ErrorReport = Match.type<CliError>().pipe(
  Match.tagsExhaustive({
    UsageError: (error) => ({ code: "usage", message: error.message }),
    AuthError: (error) => ({ code: error.code, message: error.message }),
    CommandFailed: (error) => ({ code: error.code, message: error.message }),
    ServerError: (error) => ({ code: "server_error", message: error.message }),
    ConfigFileError: (error) => ({ code: "config_error", message: error.message }),
    InputError: (error) => ({ code: "input_error", message: error.message }),
    JobError: (error) => ({ code: error.code, message: error.message }),
  }),
);

import type { ArgsSchema, ConvexCommand, WireSchema } from "@media/contracts/command";
import { commands } from "@media/contracts/commands";
import type { CommandArgs, CommandName, CommandResult, Commands } from "@media/contracts/commands";
import { CommandFailure } from "@media/contracts/errors";
import type { ErrorCode } from "@media/contracts/errors";
import { mediaServiceFunctions } from "@media/contracts/media-service";
import type { MediaServiceFunctions } from "@media/contracts/media-service";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { Match, Result, Schema } from "effect";

/** A connection, optionally signed in. */
export interface Session {
  readonly client: ConvexHttpClient;
  readonly token: string | null;
}

const SignInResult = Schema.Struct({
  tokens: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ token: Schema.String, refreshToken: Schema.String })),
  ),
});

const decodeSignInResult = Schema.decodeUnknownSync(SignInResult);

/** Params for one Convex Auth provider. */
export type SignInParams =
  | {
      readonly provider: "password";
      readonly params: {
        readonly flow: "signUp" | "signIn";
        readonly email: string;
        readonly password: string;
        readonly name?: string;
        readonly inviteCode?: string;
      };
    }
  | {
      readonly provider: "username";
      readonly params: {
        readonly flow: "signUp" | "signIn";
        readonly username: string;
        readonly password: string;
      };
    }
  | { readonly provider: "apikey"; readonly params: { readonly key: string } }
  | { readonly provider: "device"; readonly params: { readonly deviceCode: string } };

const signInAction = makeFunctionReference<"action", SignInParams>("auth:signIn");

/** Opens a connection without credentials. */
export const anonymous = (url: string): Session => ({
  client: new ConvexHttpClient(url, { logger: false }),
  token: null,
});

const withToken = (url: string, token: string): Session => {
  const client = new ConvexHttpClient(url, { logger: false });
  client.setAuth(token);

  return { client, token };
};

/** Runs Convex Auth's sign-in and returns a signed-in session, or null when it signs nobody in. */
export const trySignIn = async (url: string, params: SignInParams): Promise<Session | null> => {
  const result = decodeSignInResult(await anonymous(url).client.action(signInAction, params));
  const token = result.tokens?.token;

  return token === undefined ? null : withToken(url, token);
};

/** Signs in or throws. */
export const signIn = async (url: string, params: SignInParams): Promise<Session> => {
  const session = await trySignIn(url, params);

  if (session === null) throw new Error(`Sign-in with ${params.provider} returned no session`);

  return session;
};

const toFunctionArgs = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

const invoke = async <
  Command extends ConvexCommand<"query" | "mutation" | "action", ArgsSchema, WireSchema>,
>(
  session: Session,
  command: Command,
  args: Command["args"]["Type"],
): Promise<Command["result"]["Type"]> => {
  const encoded = toFunctionArgs(Schema.encodeUnknownSync(command.args)(args));

  const raw: unknown = await Match.value(command.kind).pipe(
    Match.when("query", () =>
      session.client.query(
        makeFunctionReference<"query", typeof encoded, unknown>(command.function),
        encoded,
      ),
    ),
    Match.when("mutation", () =>
      session.client.mutation(
        makeFunctionReference<"mutation", typeof encoded, unknown>(command.function),
        encoded,
      ),
    ),
    Match.when("action", () =>
      session.client.action(
        makeFunctionReference<"action", typeof encoded, unknown>(command.function),
        encoded,
      ),
    ),
    Match.exhaustive,
  );

  return Schema.decodeUnknownSync(command.result)(raw);
};

/** Names of commands Convex serves. */
export type ConvexCommandName = {
  readonly [Name in CommandName]: Commands[Name]["kind"] extends "media" ? never : Name;
}[CommandName];

/** Calls a command by name. */
export const run = <Name extends ConvexCommandName>(
  session: Session,
  name: Name,
  args: CommandArgs<Name>,
): Promise<CommandResult<Name>> => invoke(session, commands[name], args);

/** Calls a media service function by name. */
export const service = <Name extends keyof MediaServiceFunctions>(
  session: Session,
  name: Name,
  args: MediaServiceFunctions[Name]["args"]["Type"],
): Promise<MediaServiceFunctions[Name]["result"]["Type"]> =>
  invoke(session, mediaServiceFunctions[name], args);

const decodeFailure = Schema.decodeUnknownResult(CommandFailure);

/** The failure code a call ended with, `succeeded`, or `server_error` for an unexpected error. */
export const outcome = async (
  call: Promise<unknown>,
): Promise<ErrorCode | "succeeded" | "server_error"> => {
  try {
    await call;

    return "succeeded";
  } catch (cause) {
    if (!(cause instanceof ConvexError)) return "server_error";
    const failure = decodeFailure(cause.data);

    return Result.isSuccess(failure) ? failure.success.code : "server_error";
  }
};

/** A short random suffix, so the suite can run again against the same backend. */
export const runId = (): string => Math.random().toString(36).slice(2, 8);

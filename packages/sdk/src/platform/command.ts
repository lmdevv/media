import type { FunctionPath } from "@media/contracts/command";
import type { StaleRevision } from "@media/contracts/errors";
import type { Brand, Effect, Schema, Stream } from "effect";

import type { FunctionKind, WireArgs } from "../convex-transport";
import type { QueryWatch } from "../query-watch";
import type { CallError } from "../sdk-errors";

/**
 * The ID of a row in the platform table `Table`, such as `Id<"authSessions">`. IDs come from
 * results; an ID of one table does not type-check where another table's is expected.
 */
export type Id<Table extends string> = string & Brand.Brand<`Id<${Table}>`>;

/**
 * Every way a platform call can fail. The platform never sends `stale_revision`, so a call that
 * reads one fails with `ProtocolError` instead.
 */
export type PlatformError = Exclude<CallError, StaleRevision>;

/** One command: the Convex function it runs and the schemas of what it takes and returns. */
export interface Command<Kind extends FunctionKind, Args, Result> {
  /** The command's name, such as `core.server.info`. */
  readonly name: string;
  readonly kind: Kind;
  /** The Convex function, such as `core/server:info`. */
  readonly path: FunctionPath;
  readonly args: Schema.Codec<Args, WireArgs>;
  readonly result: Schema.Codec<Result, unknown>;
}

/** A command as `generated/commands.ts` declares it, before its kind is attached. */
export interface Declaration<Args, Result> {
  readonly name: string;
  readonly path: FunctionPath;
  readonly args: Schema.Codec<Args, WireArgs>;
  readonly result: Schema.Codec<Result, unknown>;
}

/** Declares a query command. */
export const query = <Args, Result>(
  declaration: Declaration<Args, Result>,
): Command<"query", Args, Result> => ({ ...declaration, kind: "query" });

/** Declares a mutation command. */
export const mutation = <Args, Result>(
  declaration: Declaration<Args, Result>,
): Command<"mutation", Args, Result> => ({ ...declaration, kind: "mutation" });

/** Declares an action command. */
export const action = <Args, Result>(
  declaration: Declaration<Args, Result>,
): Command<"action", Args, Result> => ({ ...declaration, kind: "action" });

/** A method's parameters: its arguments object, which may be left out when no field is required. */
export type Params<Args> = {} extends Args ? [args?: Args] : [args: Args];

type EffectCall<Args, Result> = (...params: Params<Args>) => Effect.Effect<Result, PlatformError>;

interface EffectQuery<Args, Result> {
  (...params: Params<Args>): Effect.Effect<Result, PlatformError>;
  /** The result now and after every change. Ends only by failing or being interrupted. */
  readonly watch: (...params: Params<Args>) => Stream.Stream<Result, PlatformError>;
}

/** Builds the Effect method of each command. */
export interface EffectBuilder {
  readonly query: <Args, Result>(
    command: Command<"query", Args, Result>,
  ) => EffectQuery<Args, Result>;
  readonly mutation: <Args, Result>(
    command: Command<"mutation", Args, Result>,
  ) => EffectCall<Args, Result>;
  readonly action: <Args, Result>(
    command: Command<"action", Args, Result>,
  ) => EffectCall<Args, Result>;
}

type PromiseCall<Args, Result> = (...params: Params<Args>) => Promise<Result>;

/** A Promise query method, which can also follow the query's result as it changes. */
export interface PromiseQuery<Args, Result> {
  (...params: Params<Args>): Promise<Result>;
  /**
   * The query's state, kept current while a listener is subscribed: what `usePlatformQuery`
   * renders, and what scripts can subscribe to.
   */
  readonly watch: (...params: Params<Args>) => QueryWatch<Result>;
}

/** Builds the Promise method of each command. */
export interface PromiseBuilder {
  readonly query: <Args, Result>(
    command: Command<"query", Args, Result>,
  ) => PromiseQuery<Args, Result>;
  readonly mutation: <Args, Result>(
    command: Command<"mutation", Args, Result>,
  ) => PromiseCall<Args, Result>;
  readonly action: <Args, Result>(
    command: Command<"action", Args, Result>,
  ) => PromiseCall<Args, Result>;
}

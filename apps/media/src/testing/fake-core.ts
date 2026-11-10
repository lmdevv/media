import { ProtocolError } from "@media/sdk/effect";
import type { Platform } from "@media/sdk/effect";
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect";

import * as CoreSession from "../core/core-session.ts";

type Fn<Kind extends "query" | "mutation", Args, Result> = Platform.Command<Kind, Args, Result>;

/**
 * One server function the fake core answers. It moves values between the caller's declaration and
 * its own through each one's schemas, as the wire would, so an answer the contract refuses fails.
 */
export interface Replier {
  readonly name: string;
  readonly call: <Kind extends "query" | "mutation", Args, Result>(
    fn: Fn<Kind, Args, Result>,
    args: Args,
  ) => Effect.Effect<Result, Platform.PlatformError>;
  readonly watch: <Args, Result>(
    fn: Fn<"query", Args, Result>,
    args: Args,
  ) => Stream.Stream<Result>;
}

const protocol = (name: string) => (cause: Schema.SchemaError) =>
  new ProtocolError({
    operation: name,
    message: `The fake core's ${name} does not match its contract`,
    cause,
  });

/** Moves `value` from one declaration's schema to another's, through the encoded form. */
const across = <From, To>(
  name: string,
  from: Schema.Codec<From, unknown>,
  to: Schema.Codec<To, unknown>,
  value: From,
): Effect.Effect<To, ProtocolError> =>
  Schema.encodeEffect(from)(value).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(to)),
    Effect.mapError(protocol(name)),
  );

/** Answers `target` with `answer`. */
export const reply = <Kind extends "query" | "mutation", TargetArgs, TargetResult>(
  target: Fn<Kind, TargetArgs, TargetResult>,
  answer: (args: TargetArgs) => Effect.Effect<TargetResult, Platform.PlatformError>,
): Replier => ({
  name: target.name,
  call: (fn, args) =>
    across(target.name, fn.args, target.args, args).pipe(
      Effect.flatMap(answer),
      Effect.flatMap((result) => across(target.name, target.result, fn.result, result)),
    ),
  watch: () => Stream.never,
});

/** Streams `target`'s results from `results`. */
export const stream = <TargetArgs, TargetResult>(
  target: Fn<"query", TargetArgs, TargetResult>,
  results: (args: TargetArgs) => Stream.Stream<TargetResult>,
): Replier => ({
  name: target.name,
  call: () => Effect.die(new Error(`The fake core only streams ${target.name}`)),
  watch: (fn, args) =>
    Stream.unwrap(
      across(target.name, fn.args, target.args, args).pipe(
        Effect.map((own) =>
          results(own).pipe(
            Stream.mapEffect((result) => across(target.name, target.result, fn.result, result)),
          ),
        ),
      ),
    ).pipe(Stream.orDie),
});

/** A server function call the fake core saw, by name. */
interface Call {
  readonly name: string;
}

/** The fake core's session layer and the calls it saw. */
export interface FakeCore {
  readonly calls: Effect.Effect<ReadonlyArray<Call>>;
  readonly layer: Layer.Layer<CoreSession.Service>;
}

/**
 * A signed-in core session that answers server functions through `repliers`. A function with no
 * replier dies, and a query with none streams nothing.
 */
export const makeFakeCore = (repliers: ReadonlyArray<Replier>): Effect.Effect<FakeCore> => {
  const find = (name: string) => Option.fromUndefinedOr(repliers.find((one) => one.name === name));

  return Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);

    const service = CoreSession.Service.of({
      status: Effect.succeed("signed-in"),
      run: () => Effect.die(new Error("The fake core runs no commands")),
      call: (fn, ...params) => {
        const [args] = params;

        return Ref.update(calls, (seen) => [...seen, { name: fn.name }]).pipe(
          Effect.andThen(
            Option.match(find(fn.name), {
              onNone: () => Effect.die(new Error(`The fake core has no answer for ${fn.name}`)),
              onSome: (replier) =>
                args === undefined
                  ? Effect.die(new Error(`${fn.name} was called without arguments`))
                  : replier.call(fn, args),
            }),
          ),
        );
      },
      watch: (fn, ...params) => {
        const [args] = params;

        return Option.match(find(fn.name), {
          onNone: () => Stream.never,
          onSome: (replier) => (args === undefined ? Stream.never : replier.watch(fn, args)),
        });
      },
    });

    return { calls: Ref.get(calls), layer: Layer.succeed(CoreSession.Service, service) };
  });
};

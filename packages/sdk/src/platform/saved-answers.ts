import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import type { StandIn } from "../query-watch";
import * as Client from "./client";
import type { Command } from "./command";

/** The file the app keeps one server's saved answers in. */
export interface SavedAnswersFile {
  /** The file's text; null when there is none. Rejects when it can't be read. */
  readonly read: () => Promise<string | null>;
  /** Replaces the file with `text` in one step. */
  readonly write: (text: string) => Promise<void>;
  /** Deletes the file; resolves when there is none. */
  readonly remove: () => Promise<void>;
}

/**
 * Which queries' answers the platform client saves, so the next launch shows them before the
 * server answers, and where. Every other query's answer is never saved or shown from the file.
 */
export interface SaveAnswers {
  readonly file: SavedAnswersFile;
  /** The app's release: a file another release saved reads as nothing saved. */
  readonly release: string;
  /** The queries saved, by command name, such as `movies.titles.home`. */
  readonly queries: ReadonlyArray<string>;
  /** How long a saved answer may show after it was saved. */
  readonly maxAge: Duration.Input;
  /** The longest file written or read, in characters: past it, nothing is saved. */
  readonly maxLength: number;
}

class SavedAnswersFileError extends Schema.TaggedError<
  SavedAnswersFileError,
  { readonly brand: unique symbol }
>()("SavedAnswersFileError", {
  operation: Schema.Literals(["read", "write", "remove"]),
  cause: Schema.Defect(),
}) {}

const SavedAnswer = Schema.Struct({
  query: Schema.String,
  args: Schema.String,
  savedAt: Schema.Finite,
  value: Schema.Unknown,
});

type Saved = typeof SavedAnswer.Type;

const SavedFile = Schema.fromJsonString(
  Schema.Struct({
    release: Schema.String,
    server: Schema.String,
    session: Schema.String,
    answers: Schema.Array(SavedAnswer),
  }),
);

const decodeFile = Schema.decodeUnknownOption(SavedFile);

const encodeFile = Schema.encodeSync(SavedFile);

const keyOf = (query: string, args: string): string => `${query} ${args}`;

interface Found {
  readonly session: string;
  readonly answers: ReadonlyMap<string, Saved>;
}

type Opened = Data.TaggedEnum<{
  Absent: {};
  Found: { readonly found: Found };
  Discarded: {};
  Unread: {};
}>;

const Opened = Data.taggedEnum<Opened>();

type Saving = Data.TaggedEnum<{
  Starting: {};
  Waiting: {};
  For: { readonly session: string; readonly answers: ReadonlyMap<string, Saved> };
  Off: {};
}>;

const Saving = Data.taggedEnum<Saving>();

const isStarting = Saving.$is("Starting");

const isFor = Saving.$is("For");

interface Expected {
  readonly release: string;
  readonly server: string;
  readonly queries: ReadonlySet<string>;
  readonly maxAge: Duration.Duration;
  readonly maxLength: number;
  readonly now: number;
}

const fresh = (savedAt: number, expected: Expected): boolean => {
  const age = expected.now - savedAt;

  return age >= 0 && age <= Duration.toMillis(expected.maxAge);
};

const parseSaved = (text: string, expected: Expected): Option.Option<Found> => {
  if (text.length > expected.maxLength) return Option.none();

  return decodeFile(text).pipe(
    Option.filter((file) => file.release === expected.release && file.server === expected.server),
    Option.map((file) => ({
      session: file.session,
      answers: new Map(
        file.answers.flatMap((answer) =>
          expected.queries.has(answer.query) && fresh(answer.savedAt, expected)
            ? [[keyOf(answer.query, answer.args), answer] as const]
            : [],
        ),
      ),
    })),
  );
};

const openedFrom = (text: string | null, expected: Expected): Opened => {
  if (text === null) return Opened.Absent();

  return Option.match(parseSaved(text, expected), {
    onNone: () => Opened.Discarded(),
    onSome: (found) => Opened.Found({ found }),
  });
};

/** The saved answers: what may stand in for each query, and the answers to save. */
export interface Interface {
  /**
   * The saved answer to `command` with arguments `args` (keyed as the client keys the query) that
   * may show until the server answers: one, fixed as the watch opens, while answers are saved for
   * the session signed in, then none once another session signs in. Empty for a query not saved.
   */
  readonly standIn: <Args, Result>(
    command: Command<"query", Args, Result>,
    args: string,
  ) => Stream.Stream<Option.Option<StandIn<Result>>>;
  /**
   * Saves the server's `result` for `command` with arguments `args`, when the query is saved and
   * the session signed in now is the one answers are saved for.
   */
  readonly keep: <Args, Result>(
    command: Command<"query", Args, Result>,
    args: string,
    result: Result,
  ) => Effect.Effect<void>;
}

export class SavedAnswers extends Context.Service<SavedAnswers, Interface>()(
  "@media/sdk/platform/SavedAnswers",
) {}

/** Saves nothing and shows nothing saved. */
export const layerNone: Layer.Layer<SavedAnswers> = Layer.succeed(
  SavedAnswers,
  SavedAnswers.of({ standIn: () => Stream.empty, keep: () => Effect.void }),
);

const WRITE_AFTER = Duration.seconds(1);

const onFile = <A>(operation: SavedAnswersFileError["operation"], run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SavedAnswersFileError({ operation, cause }),
  });

const logFailure = (error: SavedAnswersFileError) =>
  Effect.logWarning("SavedAnswers.fileFailed").pipe(
    Effect.annotateLogs({ operation: error.operation }),
  );

/** The file's text as the client opened, read alongside the stored session. */
export type FirstRead = Fiber.Fiber<string | null, SavedAnswersFileError>;

/** Starts reading `file` as the client opens, before its session is loaded. */
export const startReading = (file: SavedAnswersFile): FirstRead =>
  Effect.runFork(onFile("read", file.read));

/**
 * Saves the answers of `options.queries` to `options.file`, and offers them back at the next
 * launch while the same session of the same server and release is signed in.
 *
 * Who an answer belongs to: answers are saved only for the first session this client signs in as,
 * and only while it stays signed in. That connection has carried no other session's token, so
 * every answer it delivers then is that session's. When another session follows, nothing more is
 * saved or shown until the client opens again, and the file is deleted; so is any file that does
 * not belong to the session the stored session names once it is read, which finishes a sign-out
 * the app did not live to complete.
 *
 * @param server - The platform deployment's URL, which the file records and must match.
 */
export const layer = (
  options: SaveAnswers,
  server: string,
  first: FirstRead,
): Layer.Layer<SavedAnswers, never, Client.Client> =>
  Layer.effect(
    SavedAnswers,
    Effect.gen(function* () {
      const client = yield* Client.Client;
      const scope = yield* Effect.scope;
      const queries = new Set(options.queries);
      const maxAge = Duration.fromInputUnsafe(options.maxAge);
      const saving = yield* SubscriptionRef.make<Saving>(Saving.Starting());
      const disk = yield* Semaphore.make(1);
      let writeScheduled = false;

      const expected = (now: number): Expected => ({
        release: options.release,
        server,
        queries,
        maxAge,
        maxLength: options.maxLength,
        now,
      });

      const remove = disk.withPermits(1)(
        onFile("remove", options.file.remove).pipe(
          Effect.catchTag("SavedAnswersFileError", logFailure),
        ),
      );

      const write = Effect.gen(function* () {
        writeScheduled = false;
        const now = yield* Clock.currentTimeMillis;
        const state = yield* SubscriptionRef.get(saving);

        if (!isFor(state)) return;

        const text = encodeFile({
          release: options.release,
          server,
          session: state.session,
          answers: [...state.answers.values()].filter((saved) =>
            fresh(saved.savedAt, expected(now)),
          ),
        });

        if (text.length > options.maxLength) {
          yield* Effect.logWarning("SavedAnswers.tooLong");
          yield* onFile("remove", options.file.remove);

          return;
        }

        yield* onFile("write", () => options.file.write(text));
      }).pipe(disk.withPermits(1), Effect.catchTag("SavedAnswersFileError", logFailure));

      const opened = yield* Effect.cached(
        Effect.gen(function* () {
          const text = yield* Fiber.join(first);
          const now = yield* Clock.currentTimeMillis;

          return openedFrom(text, expected(now));
        }).pipe(
          Effect.catchTag("SavedAnswersFileError", (error) =>
            Effect.as(logFailure(error), Opened.Unread()),
          ),
        ),
      );

      const signedIn = Stream.zipLatest(client.session.status, client.session.identity).pipe(
        Stream.filter(([status]) => status !== "loading"),
        Stream.map(([, identity]) => identity),
        Stream.changesWith(Option.makeEquivalence((a: string, b: string) => a === b)),
      );

      const begin = Effect.fn("SavedAnswers.begin")(function* (identity: Option.Option<string>) {
        const file = yield* opened;
        const found = Opened.$is("Found")(file) ? Option.some(file.found) : Option.none();
        const owned = Option.filter(found, (saved) => Option.contains(identity, saved.session));

        if (Option.isNone(owned) && !Opened.$is("Absent")(file) && !Opened.$is("Unread")(file)) {
          yield* remove;
        }

        return Option.match(identity, {
          onNone: () => Saving.Waiting(),
          onSome: (session) =>
            Saving.For({
              session,
              answers: Option.match(owned, {
                onNone: () => new Map<string, Saved>(),
                onSome: (saved) => saved.answers,
              }),
            }),
        });
      });

      const follow = Effect.fn("SavedAnswers.follow")(function* (identity: Option.Option<string>) {
        const state = yield* SubscriptionRef.get(saving);

        const next = yield* Saving.$match(state, {
          Starting: () => begin(identity),
          Waiting: () =>
            Effect.succeed(
              Option.match(identity, {
                onNone: () => state,
                onSome: (session) => Saving.For({ session, answers: new Map() }),
              }),
            ),
          For: ({ session }) =>
            Effect.succeed(Option.contains(identity, session) ? state : Saving.Off()),
          Off: () => Effect.succeed(state),
        });

        yield* SubscriptionRef.set(saving, next);

        if (isFor(state) && Saving.$is("Off")(next)) yield* remove;
      });

      yield* Effect.forkScoped(Stream.runForEach(signedIn, follow));

      const states = SubscriptionRef.changes(saving).pipe(Stream.filter(Predicate.not(isStarting)));

      const savedIn = (state: Option.Option<Saving>, key: string): Option.Option<Saved> =>
        Option.flatMap(Option.filter(state, isFor), (saved) =>
          Option.fromUndefinedOr(saved.answers.get(key)),
        );

      return SavedAnswers.of({
        standIn: <Args, Result>(command: Command<"query", Args, Result>, args: string) => {
          if (!queries.has(command.name)) return Stream.empty;

          const decode = Schema.decodeUnknownOption(command.result);
          const withdrawn = states.pipe(Stream.filter(Predicate.not(isFor)), Stream.take(1));

          const atOpen = Stream.runHead(states);

          return Stream.unwrap(
            Effect.map(atOpen, (state) =>
              Option.match(savedIn(state, keyOf(command.name, args)), {
                onNone: () => Stream.empty,
                onSome: (saved) =>
                  Stream.concat(
                    Stream.make(Option.some<StandIn<Result>>(() => decode(saved.value))),
                    Stream.as(withdrawn, Option.none()),
                  ),
              }),
            ),
          );
        },
        keep: (command, args, result) =>
          Effect.gen(function* () {
            if (!queries.has(command.name)) return;

            const state = yield* SubscriptionRef.get(saving);
            const identity = yield* client.session.currentIdentity;

            if (!isFor(state) || !Option.contains(identity, state.session)) return;

            const value = Schema.encodeUnknownOption(command.result)(result);

            if (Option.isNone(value)) return;

            const savedAt = yield* Clock.currentTimeMillis;
            const answers = new Map(state.answers);

            answers.set(keyOf(command.name, args), {
              query: command.name,
              args,
              savedAt,
              value: value.value,
            });
            yield* SubscriptionRef.set(saving, Saving.For({ session: state.session, answers }));

            if (writeScheduled) return;

            writeScheduled = true;
            yield* Effect.forkIn(Effect.delay(write, WRITE_AFTER), scope);
          }),
      });
    }),
  );

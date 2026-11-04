import {
  Clock,
  Console,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Ref,
  Result,
  Schedule,
  Scope,
  Semaphore,
} from "effect";

import * as MediaConfig from "../media-config.ts";
import { isNotFound, modifiedAtMs } from "../platform/file-info.ts";
import {
  byAge,
  fileCapBytes,
  fileName,
  type LogFile,
  nextSequence,
  orderOf,
  planMigration,
  planPrune,
  type Retention,
  shouldRotate,
} from "./log-files.ts";

interface Snapshot {
  readonly directory: string;
  readonly files: ReadonlyArray<LogFile>;
  readonly live: PubSub.Subscription<string>;
  readonly unavailableSince: Option.Option<number>;
}

/** The retained log. */
export interface Interface {
  /**
   * Queues one line, logged at `loggedAt`; it is written within a moment. Never blocks, so a
   * logger may call it.
   */
  readonly append: (line: string, loggedAt: number) => void;
  /** Writes every queued line now. */
  readonly flush: Effect.Effect<void>;
  /** The files as they stand now and the lines written from now on, for the rest of the scope. */
  readonly snapshot: Effect.Effect<Snapshot, never, Scope.Scope>;
  /**
   * Completes once the service begins to shut down. A reader that follows the log ends then, so
   * an open follow never holds up the shutdown.
   */
  readonly closing: Effect.Effect<void>;
  /** Begins the shutdown for readers: every follow ends now. */
  readonly close: Effect.Effect<void>;
}

/** The retained log service. */
export class Service extends Context.Service<Service, Interface>()("@media/server/RetainedLogs") {}

/** Where and how much to keep. */
export interface Settings {
  readonly directory: string;
  readonly retention: Retention;
}

const MAX_PENDING_CHARS = 8 * 1024 * 1024;

const LIVE_CAPACITY = 4096;

const FLUSH_INTERVAL = Duration.millis(250);

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const DIRECTORY_MODE = 0o700;

const FILE_MODE = 0o600;

interface OpenFile {
  readonly name: string;
  readonly startsAt: number;
  readonly sizeBytes: number;
  readonly handle: FileSystem.File;
  readonly scope: Scope.Closeable;
}

interface Entry {
  readonly line: string;
  readonly loggedAt: number;
}

const encoder = new TextEncoder();

const ownLine = (
  level: "WARN" | "ERROR",
  message: string,
  annotations: Readonly<Record<string, string | number>>,
  now: number,
): string =>
  JSON.stringify({
    message,
    level,
    timestamp: new Date(now).toISOString(),
    annotations,
    spans: {},
  });

const afterLineBreak = (chunk: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(chunk.length + 1);

  bytes[0] = 0x0a;
  bytes.set(chunk, 1);

  return bytes;
};

interface Chunk {
  readonly bytes: Uint8Array;
  readonly lines: number;
  readonly firstAt: number;
}

interface Chunks {
  readonly chunks: ReadonlyArray<Chunk>;
  readonly lines: ReadonlyArray<string>;
  readonly oversized: number;
}

const chunksOf = (entries: ReadonlyArray<Entry>, capBytes: number): Chunks => {
  const chunks: Array<Chunk> = [];
  const lines: Array<string> = [];
  let group: Array<string> = [];
  let groupBytes = 0;
  let firstAt = Number.POSITIVE_INFINITY;
  let oversized = 0;

  const close = (): void => {
    if (group.length > 0) {
      chunks.push({ bytes: encoder.encode(`${group.join("\n")}\n`), lines: group.length, firstAt });
    }

    group = [];
    groupBytes = 0;
    firstAt = Number.POSITIVE_INFINITY;
  };

  for (const entry of entries) {
    const bytes = encoder.encode(entry.line).length + 1;

    if (bytes > capBytes) {
      oversized += 1;
      continue;
    }

    if (groupBytes + bytes > capBytes) close();
    group.push(entry.line);
    lines.push(entry.line);
    groupBytes += bytes;
    firstAt = Math.min(firstAt, entry.loggedAt);
  }

  close();

  return { chunks, lines, oversized };
};

/** Builds the writer for `settings`; it lives, and flushes a last time, until the scope closes. */
export const make = Effect.fn("RetainedLogs.make")(function* (settings: Settings) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const published = yield* PubSub.sliding<string>(LIVE_CAPACITY);
  const closing = yield* Deferred.make<void>();
  const current = yield* Ref.make(Option.none<OpenFile>());
  const lastPrune = yield* Ref.make(0);
  const totalBytes = yield* Ref.make(0);
  const sequence = yield* Ref.make(0);
  const capBytes = fileCapBytes(settings.retention.maxBytes);

  const queue = { entries: Array.of<Entry>(), chars: 0 };

  const counters = {
    dropped: 0,
    failingSince: Option.none<number>(),
    partial: false,
    stale: true,
  };

  // The mode is tightened where it can be; a folder the service may write but not chmod, such
  // as one another user owns, is still written.
  const ensureDirectory = fs
    .makeDirectory(settings.directory, { recursive: true, mode: DIRECTORY_MODE })
    .pipe(Effect.andThen(fs.chmod(settings.directory, DIRECTORY_MODE).pipe(Effect.ignore)));

  const listFiles = Effect.gen(function* () {
    const names = yield* fs.readDirectory(settings.directory);

    const files = yield* Effect.forEach(names, (name) =>
      Option.match(orderOf(name), {
        onNone: () => Effect.succeed(Option.none<LogFile>()),
        onSome: (order) =>
          fs.stat(path.join(settings.directory, name)).pipe(
            Effect.map((info) =>
              Option.some<LogFile>({
                name,
                ...order,
                sizeBytes: Number(info.size),
                modifiedAt: modifiedAtMs(info),
              }),
            ),
            Effect.orElseSucceed(() => Option.none<LogFile>()),
          ),
      }),
    );

    return files.flatMap((file) => (Option.isSome(file) ? [file.value] : [])).toSorted(byAge);
  });

  const prune = Effect.fnUntraced(function* (reserveBytes: number) {
    const now = yield* Clock.currentTimeMillis;
    const listed = yield* Effect.result(listFiles);

    if (Result.isFailure(listed)) {
      counters.stale = true;

      return;
    }

    const files = listed.success;
    const active = Option.map(yield* Ref.get(current), (file) => file.name);
    const doomed = new Set(planPrune(files, settings.retention, now, active, reserveBytes));

    yield* Effect.forEach(
      doomed,
      (name) =>
        fs.remove(path.join(settings.directory, name)).pipe(
          Effect.catchIf(isNotFound, () => Effect.void),
          Effect.catch((error) =>
            Console.error(`Retained log ${name} could not be deleted: ${error.message}`),
          ),
        ),
      { discard: true },
    );
    yield* Ref.update(sequence, (next) => Math.max(next, nextSequence(files)));
    yield* Ref.set(
      totalBytes,
      files.reduce((total, file) => (doomed.has(file.name) ? total : total + file.sizeBytes), 0),
    );
    yield* Ref.set(lastPrune, now);
    counters.stale = false;
  });

  const closeCurrent = Effect.gen(function* () {
    const previous = yield* Ref.getAndSet(current, Option.none());

    if (Option.isSome(previous)) yield* Scope.close(previous.value.scope, Exit.void);
  });

  const rotate = Effect.fnUntraced(function* (startsAt: number) {
    yield* closeCurrent;
    yield* ensureDirectory;

    if (counters.stale) yield* prune(0);

    const fileScope = yield* Scope.make("sequential");
    const name = fileName(yield* Ref.getAndUpdate(sequence, (next) => next + 1), startsAt);

    const handle = yield* fs
      .open(path.join(settings.directory, name), { flag: "a", mode: FILE_MODE })
      .pipe(Scope.provide(fileScope));

    const opened: OpenFile = { name, startsAt, sizeBytes: 0, handle, scope: fileScope };

    yield* Ref.set(current, Option.some(opened));
    counters.partial = false;

    return opened;
  });

  const fileFor = Effect.fnUntraced(function* (chunk: Chunk, bytes: number) {
    const open = yield* Ref.get(current);

    if (Option.isSome(open) && !shouldRotate(open.value, chunk.firstAt, capBytes, bytes)) {
      if (yield* fs.exists(path.join(settings.directory, open.value.name))) return open.value;
      counters.stale = true;
    }

    return yield* rotate(chunk.firstAt);
  });

  const writeChunk = Effect.fnUntraced(function* (chunk: Chunk) {
    const file = yield* fileFor(chunk, chunk.bytes.length + (counters.partial ? 1 : 0));
    const bytes = counters.partial ? afterLineBreak(chunk.bytes) : chunk.bytes;

    if ((yield* Ref.get(totalBytes)) + bytes.length > settings.retention.maxBytes) {
      yield* prune(bytes.length);
    }

    counters.partial = true;
    yield* file.handle.writeAll(bytes).pipe(
      Effect.tapError(() =>
        file.handle.stat.pipe(
          Effect.flatMap((info) =>
            Ref.set(current, Option.some({ ...file, sizeBytes: Number(info.size) })),
          ),
          Effect.ignore,
        ),
      ),
    );
    counters.partial = false;
    yield* Ref.set(current, Option.some({ ...file, sizeBytes: file.sizeBytes + bytes.length }));
    yield* Ref.update(totalBytes, (total) => total + bytes.length);
  });

  const failed = (now: number, error: { readonly message: string }) =>
    Option.isSome(counters.failingSince)
      ? Effect.void
      : Effect.andThen(
          Effect.sync(() => {
            counters.failingSince = Option.some(now);
          }),
          Console.log(
            ownLine(
              "WARN",
              "RetainedLogs.unwritable",
              { directory: settings.directory, error: error.message },
              now,
            ),
          ),
        );

  const write = Effect.fnUntraced(function* (now: number, queued: ReadonlyArray<Entry>) {
    const dropped = counters.dropped;

    counters.dropped = 0;

    const entries: ReadonlyArray<Entry> =
      dropped > 0
        ? [
            ...queued,
            {
              line: ownLine("WARN", "RetainedLogs.dropped", { lines: dropped }, now),
              loggedAt: now,
            },
          ]
        : queued;

    const { chunks, lines, oversized } = chunksOf(entries, capBytes);

    counters.dropped += oversized;

    let written = 0;

    yield* Effect.forEach(
      chunks,
      (chunk) =>
        Effect.andThen(
          writeChunk(chunk),
          Effect.sync(() => {
            written += 1;
          }),
        ),
      { discard: true },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          counters.failingSince = Option.none();
        }),
      ),
      Effect.catch((error) =>
        Effect.andThen(
          Effect.sync(() => {
            counters.dropped +=
              dropped +
              chunks.slice(written).reduce((total, chunk) => total + chunk.lines, 0) -
              (dropped > 0 ? 1 : 0);
            counters.stale = true;
          }),
          failed(now, error),
        ),
      ),
    );
    yield* PubSub.publishAll(published, lines);
  });

  const flushLocked = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const queued = queue.entries;

    queue.entries = [];
    queue.chars = 0;

    if (queued.length > 0 || counters.dropped > 0) yield* write(now, queued);

    if (counters.stale || Math.abs(now - (yield* Ref.get(lastPrune))) >= PRUNE_INTERVAL_MS) {
      yield* prune(0);
    }
  });

  const flush = lock.withPermits(1)(flushLocked);

  const close = Deferred.succeed(closing, undefined).pipe(Effect.asVoid);

  const migrate = fs.readDirectory(settings.directory).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(
        planMigration(names),
        ([from, to]) =>
          fs
            .rename(path.join(settings.directory, from), path.join(settings.directory, to))
            .pipe(Effect.ignore),
        { discard: true },
      ),
    ),
    Effect.ignore,
  );

  const startedAt = yield* Clock.currentTimeMillis;

  yield* ensureDirectory.pipe(Effect.catch((error) => failed(startedAt, error)));
  yield* migrate;
  yield* Effect.forEach(
    yield* listFiles.pipe(Effect.orElseSucceed(() => [])),
    (file) => fs.chmod(path.join(settings.directory, file.name), FILE_MODE).pipe(Effect.ignore),
    { discard: true },
  );
  yield* prune(0);

  // Registered before the flushing fiber starts, so it runs after that fiber stopped: nothing can
  // open a file after the last flush closed it.
  yield* Effect.addFinalizer(() =>
    lock.withPermits(1)(Effect.andThen(flushLocked, closeCurrent)).pipe(Effect.andThen(close)),
  );
  yield* Effect.forkScoped(
    Effect.repeat(Effect.uninterruptible(flush), Schedule.spaced(FLUSH_INTERVAL)),
  );

  return Service.of({
    append: (line, loggedAt) => {
      if (queue.chars + line.length > MAX_PENDING_CHARS) {
        counters.dropped += 1;

        return;
      }

      queue.entries.push({ line, loggedAt });
      queue.chars += line.length;
    },
    flush,
    snapshot: lock.withPermits(1)(
      Effect.gen(function* () {
        yield* flushLocked;
        const now = yield* Clock.currentTimeMillis;
        const listed = yield* Effect.result(listFiles);
        const live = yield* PubSub.subscribe(published);

        return {
          directory: settings.directory,
          files: Result.getOrElse(listed, () => []),
          live,
          unavailableSince: Option.orElse(counters.failingSince, () =>
            Result.isFailure(listed) ? Option.some(now) : Option.none(),
          ),
        } satisfies Snapshot;
      }),
    ),
    closing: Deferred.await(closing),
    close,
  });
});

/** The writer for the configured `DATA_DIR/logs`. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;

    return yield* make({
      directory: config.logs.directory,
      retention: {
        maxAgeMs: Duration.toMillis(config.logs.retention),
        maxBytes: config.logs.maxBytes,
      },
    });
  }),
);

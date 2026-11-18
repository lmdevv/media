import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import {
  Clock,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  PubSub,
} from "effect";
import { TestClock } from "effect/testing";

import { byAge, fileCapBytes, fileName, MIN_LOG_BYTES, orderOf } from "./log-files.ts";
import * as RetainedLogs from "./retained-logs.ts";

const DAY = 86_400_000;

const MEBIBYTE = 1024 * 1024;

const appendNow = (logs: RetainedLogs.Interface, line: string) =>
  Effect.map(Clock.currentTimeMillis, (now) => logs.append(line, now));

const writerIn = (maxBytes = 512 * MEBIBYTE) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "media-logs-" });

    yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

    const logs = yield* RetainedLogs.make({
      directory,
      retention: { maxAgeMs: 14 * DAY, maxBytes },
    });

    return { logs, directory };
  });

const linesIn = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const names = (yield* fs.readDirectory(directory)).toSorted((left, right) =>
      Option.match(Option.all([orderOf(left), orderOf(right)]), {
        onNone: () => left.localeCompare(right),
        onSome: ([leftOrder, rightOrder]) => byAge(leftOrder, rightOrder),
      }),
    );

    return yield* Effect.forEach(names, (name) =>
      fs
        .readFileString(path.join(directory, name))
        .pipe(Effect.map((text) => ({ name, lines: text.split("\n").filter(Boolean) }))),
    );
  });

const diskFullOnce = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const state = { failed: false };

  const failingOnce = (file: FileSystem.File): FileSystem.File => ({
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: file.stat,
    seek: (offset, from) => file.seek(offset, from),
    sync: file.sync,
    read: (buffer, options) => file.read(buffer, options),
    readAlloc: (size, options) => file.readAlloc(size, options),
    truncate: (length) => file.truncate(length),
    write: (buffer) => file.write(buffer),
    writeAll: (buffer) => {
      if (state.failed) return file.writeAll(buffer);
      state.failed = true;

      return Effect.andThen(
        file.writeAll(buffer.subarray(0, Math.floor(buffer.length / 2))),
        Effect.fail(
          PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "writeAll" }),
        ),
      );
    },
  });

  return FileSystem.FileSystem.of({
    ...fs,
    open: (path, options) => Effect.map(fs.open(path, options), failingOnce),
  });
});

layer(NodeServices.layer)("retained log writer", (it) => {
  it.effect("ends a line a failed write cut short before writing the next", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "media-logs-" });

      yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: MIN_LOG_BYTES },
      }).pipe(Effect.provideService(FileSystem.FileSystem, yield* diskFullOnce));

      yield* appendNow(logs, '{"n":1,"padding":"cut here"}');
      yield* logs.flush;
      yield* appendNow(logs, '{"n":2}');
      yield* logs.flush;

      const [only] = yield* linesIn(directory);

      assert.deepStrictEqual(only?.lines.slice(0, 2), ['{"n":1,"paddin', '{"n":2}']);
    }).pipe(Effect.scoped),
  );

  it.effect("appends lines to one file and starts another the next day", () =>
    Effect.gen(function* () {
      const { logs, directory } = yield* writerIn();

      yield* appendNow(logs, '{"n":1}');
      yield* appendNow(logs, '{"n":2}');
      yield* logs.flush;
      yield* TestClock.adjust(Duration.days(1));
      yield* appendNow(logs, '{"n":3}');
      yield* logs.flush;

      const files = yield* linesIn(directory);

      assert.deepStrictEqual(
        files.map((entry) => entry.lines),
        [['{"n":1}', '{"n":2}'], ['{"n":3}']],
      );
      assert.isTrue(files.every((entry) => Option.isSome(orderOf(entry.name))));
    }).pipe(Effect.scoped),
  );

  it.effect("starts another file once the current one reaches its share of the cap", () =>
    Effect.gen(function* () {
      const { logs, directory } = yield* writerIn(8 * MEBIBYTE);
      const line = "x".repeat(64 * 1024);
      const linesPerFile = Math.floor(fileCapBytes(8 * MEBIBYTE) / (line.length + 1));
      const written = linesPerFile + 4;

      for (let index = 0; index < written; index += 1) {
        yield* appendNow(logs, line);
        yield* logs.flush;
      }

      const files = yield* linesIn(directory);

      assert.deepStrictEqual(
        files.map((entry) => entry.lines.length),
        [linesPerFile, written - linesPerFile],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("never lets the folder grow past its cap, and keeps several files in it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { logs, directory } = yield* writerIn(MIN_LOG_BYTES);
      const line = "x".repeat(64 * 1024);
      const folderBytes = Array.of<number>();

      for (let index = 0; index < 400; index += 1) {
        yield* appendNow(logs, line);
        yield* logs.flush;

        const sizes = yield* Effect.forEach(yield* fs.readDirectory(directory), (name) =>
          Effect.map(fs.stat(path.join(directory, name)), (info) => Number(info.size)),
        );

        folderBytes.push(sizes.reduce((total, size) => total + size, 0));
      }

      assert.isAtMost(Math.max(...folderBytes), MIN_LOG_BYTES);
      assert.isAtLeast((yield* fs.readDirectory(directory)).length, 7);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps its folder and files private to the service", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "media-logs-" });
      const directory = path.join(parent, "logs");
      const earlier = path.join(directory, fileName(0, Date.UTC(2026, 9, 20)));

      yield* fs.makeDirectory(directory, { mode: 0o755 });
      yield* fs.writeFileString(earlier, "{}\n", { mode: 0o644 });
      yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: MIN_LOG_BYTES },
      });

      yield* appendNow(logs, '{"n":1}');
      yield* logs.flush;

      const modes = yield* Effect.forEach(
        [
          directory,
          ...(yield* fs.readDirectory(directory)).map((name) => path.join(directory, name)),
        ],
        (entry) => Effect.map(fs.stat(entry), (info) => info.mode & 0o777),
      );

      assert.deepStrictEqual(modes, [0o700, 0o600, 0o600]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps running without its folder, and writes again once it can", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "media-logs-" });
      const directory = path.join(parent, "logs");

      yield* fs.writeFileString(directory, "");
      yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: MIN_LOG_BYTES },
      });

      yield* appendNow(logs, '{"n":1}');
      yield* logs.flush;
      yield* fs.remove(directory);
      yield* appendNow(logs, '{"n":2}');
      yield* logs.flush;

      const recovered = (yield* linesIn(directory)).flatMap((entry) => entry.lines);

      assert.strictEqual(recovered[0], '{"n":2}');
      assert.match(recovered[1] ?? "", /"RetainedLogs\.dropped".*"lines":1/u);

      yield* fs.remove(directory, { recursive: true });
      yield* appendNow(logs, '{"n":3}');
      yield* logs.flush;

      assert.deepStrictEqual(
        (yield* linesIn(directory)).map((entry) => entry.lines),
        [['{"n":3}']],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("names each file after a time none of its records is earlier than", () =>
    Effect.gen(function* () {
      const { logs, directory } = yield* writerIn();
      const loggedAt = Date.UTC(2026, 9, 21, 12) + 100;

      yield* TestClock.adjust(Duration.millis(100));
      yield* appendNow(logs, `{"timestamp":"${new Date(loggedAt).toISOString()}"}`);
      yield* TestClock.adjust(Duration.millis(400));
      yield* logs.flush;

      const [only] = yield* linesIn(directory);

      assert.isAtMost(
        Option.getOrThrow(orderOf(only?.name ?? "")).startsAt,
        loggedAt,
        "the file's name is no later than its first record",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("ends every follow when it begins to close", () =>
    Effect.gen(function* () {
      const { logs } = yield* writerIn();
      const closing = yield* Effect.forkChild(logs.closing);

      yield* logs.close;

      assert.isTrue(Option.isSome(yield* Fiber.await(closing).pipe(Effect.option)));
    }).pipe(Effect.scoped),
  );

  it.effect("starts a new file in a new process, so a line a crash cut short stays alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "media-logs-" });
      const crashed = fileName(0, Date.UTC(2026, 9, 21, 11));

      yield* fs.writeFileString(path.join(directory, crashed), '{"n":1}\n{"n":2,"cut');
      yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: 512 * MEBIBYTE },
      });

      yield* appendNow(logs, '{"n":3}');
      yield* logs.flush;

      const files = yield* linesIn(directory);

      assert.deepStrictEqual(
        files.map((entry) => entry.lines),
        [['{"n":1}', '{"n":2,"cut'], ['{"n":3}']],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("deletes expired files at startup and leaves foreign files alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "media-logs-" });
      const expired = fileName(0, Date.UTC(2026, 8, 1));
      const kept = fileName(1, Date.UTC(2026, 9, 20));

      for (const name of [expired, kept, "README.txt"]) {
        yield* fs.writeFileString(path.join(directory, name), "{}\n");
      }

      yield* fs.utimes(path.join(directory, expired), new Date(2026, 8, 2), new Date(2026, 8, 2));
      yield* fs.utimes(path.join(directory, kept), new Date(2026, 9, 20), new Date(2026, 9, 20));
      yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

      yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: 512 * MEBIBYTE },
      });

      assert.sameMembers(yield* fs.readDirectory(directory), [kept, "README.txt"]);
    }).pipe(Effect.scoped),
  );

  it.effect("hands a snapshot the lines written so far and later lines live, never both", () =>
    Effect.gen(function* () {
      const { logs } = yield* writerIn();

      yield* appendNow(logs, '{"n":1}');

      const snapshot = yield* logs.snapshot;

      yield* appendNow(logs, '{"n":2}');
      yield* logs.flush;

      assert.deepStrictEqual(
        snapshot.files.map((entry) => entry.sizeBytes),
        ['{"n":1}\n'.length],
      );
      assert.deepStrictEqual(yield* PubSub.takeAll(snapshot.live), ['{"n":2}']);
    }).pipe(Effect.scoped),
  );

  it.effect("bounds the lines waiting to be written by their size, and counts what it drops", () =>
    Effect.gen(function* () {
      const { logs, directory } = yield* writerIn();
      const line = "x".repeat(64 * 1024);

      for (let index = 0; index < 200; index += 1) yield* appendNow(logs, line);
      yield* logs.flush;

      const lines = (yield* linesIn(directory)).flatMap((entry) => entry.lines);
      const kept = lines.filter((entry) => entry === line).length;

      assert.isBelow(kept, 200);
      assert.isAtMost(kept * line.length, 8 * MEBIBYTE);
      assert.match(
        lines.at(-1) ?? "",
        new RegExp(String.raw`"RetainedLogs\.dropped".*"lines":${String(200 - kept)}\b`, "u"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("tells readers since when it could not write, until it writes again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "media-logs-" });
      const directory = path.join(parent, "logs");
      const failedAt = Date.UTC(2026, 9, 21, 12);

      yield* fs.writeFileString(directory, "");
      yield* TestClock.setTime(failedAt);

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: MIN_LOG_BYTES },
      });

      yield* TestClock.adjust(Duration.minutes(5));
      yield* appendNow(logs, '{"n":1}');

      assert.deepStrictEqual((yield* logs.snapshot).unavailableSince, Option.some(failedAt));

      yield* fs.remove(directory);
      yield* appendNow(logs, '{"n":2}');

      assert.deepStrictEqual((yield* logs.snapshot).unavailableSince, Option.none());
    }).pipe(Effect.scoped),
  );

  it.effect("counts files in a folder that appears later against the cap at once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "media-logs-" });
      const directory = path.join(parent, "logs");
      const earlier = Date.UTC(2026, 9, 20);

      yield* fs.writeFileString(directory, "");
      yield* TestClock.setTime(Date.UTC(2026, 9, 21, 12));

      const logs = yield* RetainedLogs.make({
        directory,
        retention: { maxAgeMs: 14 * DAY, maxBytes: MIN_LOG_BYTES },
      });

      yield* fs.remove(directory);
      yield* fs.makeDirectory(directory);

      for (let index = 0; index < 8; index += 1) {
        yield* fs.writeFileString(
          path.join(directory, fileName(index, earlier + index)),
          `${"x".repeat(MEBIBYTE - 1)}\n`,
        );
      }

      yield* appendNow(logs, '{"n":1}');
      yield* logs.flush;

      const files = yield* linesIn(directory);

      assert.isAtMost(
        files.reduce(
          (total, entry) => total + entry.lines.reduce((sum, text) => sum + text.length + 1, 0),
          0,
        ),
        MIN_LOG_BYTES,
      );
      assert.deepStrictEqual(files.at(-1)?.lines, ['{"n":1}']);
      assert.strictEqual(
        Option.getOrThrow(orderOf(files.at(-1)?.name ?? "")).sequence,
        8,
        "the new file comes after the files it found",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("starts one file for a new day, named after its first record", () =>
    Effect.gen(function* () {
      const { logs, directory } = yield* writerIn();
      const midnight = Date.UTC(2026, 9, 22);

      yield* TestClock.setTime(midnight - 100);
      yield* appendNow(logs, '{"n":1}');
      yield* logs.flush;
      yield* TestClock.adjust(Duration.millis(150));
      yield* appendNow(logs, '{"n":2}');
      yield* TestClock.adjust(Duration.millis(100));
      yield* logs.flush;
      yield* TestClock.adjust(Duration.millis(250));
      yield* appendNow(logs, '{"n":3}');
      yield* logs.flush;

      const files = yield* linesIn(directory);

      assert.deepStrictEqual(
        files.map((entry) => entry.lines),
        [['{"n":1}'], ['{"n":2}', '{"n":3}']],
      );
      assert.strictEqual(Option.getOrThrow(orderOf(files[1]?.name ?? "")).startsAt, midnight + 50);
    }).pipe(Effect.scoped),
  );

  it.effect("never hands a follower a line too large for any file", () =>
    Effect.gen(function* () {
      const { logs } = yield* writerIn(MIN_LOG_BYTES);
      const snapshot = yield* logs.snapshot;

      yield* appendNow(logs, "x".repeat(fileCapBytes(MIN_LOG_BYTES) + 1));
      yield* appendNow(logs, '{"n":1}');
      yield* logs.flush;

      const live = yield* PubSub.takeAll(snapshot.live);

      assert.deepStrictEqual(live, ['{"n":1}']);
    }).pipe(Effect.scoped),
  );
});

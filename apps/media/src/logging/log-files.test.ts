import { Option } from "effect";
import { assert, describe, it } from "vitest";

import {
  fileCapBytes,
  fileName,
  type LogFile,
  MIN_LOG_BYTES,
  orderOf,
  planPrune,
  shouldRotate,
} from "./log-files.ts";

const DAY = 86_400_000;

const file = (sequence: number, sizeBytes: number, modifiedAt: number): LogFile => ({
  name: fileName(sequence, modifiedAt),
  startsAt: modifiedAt,
  sequence,
  sizeBytes,
  modifiedAt,
});

describe("log file names", () => {
  it("round-trips the sequence and start time, lists in sequence order, and ignores other files", () => {
    const startsAt = Date.UTC(2026, 9, 21, 14, 5, 3, 123);

    assert.strictEqual(fileName(42, startsAt), "media-000000000042-20261021T140503123Z.ndjson");
    assert.deepStrictEqual(
      orderOf(fileName(42, startsAt)),
      Option.some({ sequence: 42, startsAt }),
    );
    assert.isTrue(fileName(9, startsAt) < fileName(10, startsAt - DAY));
    assert.isTrue(Option.isNone(orderOf("notes.txt")));
    assert.isTrue(Option.isNone(orderOf(`${fileName(1, startsAt)}.gz`)));
    assert.isTrue(Option.isNone(orderOf("media-20261021T140503123Z.ndjson")));
  });
});

describe("file size", () => {
  it("gives each file an eighth of the cap, so the smallest cap still keeps eight files", () => {
    assert.strictEqual(fileCapBytes(MIN_LOG_BYTES), MIN_LOG_BYTES / 8);
    assert.strictEqual(fileCapBytes(512 * 1024 * 1024), 64 * 1024 * 1024);
    assert.strictEqual(fileCapBytes(4096 * 1024 * 1024), 64 * 1024 * 1024);
  });

  it("starts another file before a write would grow the current one past its share", () => {
    const now = Date.UTC(2026, 9, 21, 12);
    const current = { startsAt: now, sizeBytes: 90 };

    assert.isFalse(shouldRotate(current, now, 100, 10));
    assert.isTrue(shouldRotate(current, now, 100, 11));
    assert.isTrue(shouldRotate(current, now + DAY, 100, 0));
    assert.isTrue(shouldRotate(current, now - 1, 100, 0), "the clock stepped back");
  });
});

describe("retention", () => {
  const now = Date.UTC(2026, 9, 21);
  const retention = { maxAgeMs: 14 * DAY, maxBytes: 100 };

  it("deletes files last written before the retention period", () => {
    const old = file(1, 10, now - 15 * DAY);
    const recent = file(2, 10, now - 13 * DAY);

    assert.deepStrictEqual(planPrune([recent, old], retention, now, Option.none()), [old.name]);
  });

  it("deletes the oldest files until the rest fit the size cap", () => {
    const oldest = file(1, 60, now - 3);
    const files = [oldest, file(2, 30, now - 2), file(3, 30, now - 1)];

    assert.deepStrictEqual(planPrune(files, retention, now, Option.none()), [oldest.name]);
  });

  it("makes room for what is about to be written", () => {
    const oldest = file(1, 30, now - 3);
    const files = [oldest, file(2, 30, now - 2), file(3, 30, now - 1)];

    assert.deepStrictEqual(planPrune(files, retention, now, Option.none(), 10), []);
    assert.deepStrictEqual(planPrune(files, retention, now, Option.none(), 11), [oldest.name]);
  });

  it("never deletes the file being written", () => {
    const active = file(1, 500, now - 15 * DAY);

    assert.deepStrictEqual(planPrune([active], retention, now, Option.some(active.name)), []);
  });

  it("deletes nothing more when run again on what it left", () => {
    const files = [
      file(1, 10, now - 30 * DAY),
      file(2, 60, now - 3),
      file(3, 30, now - 2),
      file(4, 30, now - 1),
    ];

    const doomed = new Set(planPrune(files, retention, now, Option.none()));
    const left = files.filter((candidate) => !doomed.has(candidate.name));

    assert.deepStrictEqual(planPrune(left, retention, now, Option.none()), []);
  });
});

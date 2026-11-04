import { describe, expect, it } from "@effect/vitest";
import { Duration, Option, Schema } from "effect";

import { Bytes, EpochMillis } from "@media/contracts/units";

import * as Archives from "./backup-archives.ts";

const Instant = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_000_000_000_000 }));

const Trigger = Schema.Literals(["nightly", "manual"]);

const DAY_MS = 24 * 60 * 60 * 1000;

const archive = (fileName: string, takenAt: number) => ({
  fileName,
  sizeBytes: Bytes.make(1),
  trigger: "manual" as const,
  takenAt: EpochMillis.make(takenAt),
});

describe("archive names", () => {
  it.prop("encode the trigger and time they were taken at", [Trigger, Instant], ([trigger, at]) => {
    const name = Archives.archiveName(trigger, at);

    expect(Archives.isArchiveName(name)).toBe(true);
    expect(Archives.isPartial(Archives.partialName(name))).toBe(true);
    expect(Archives.isArchiveName(Archives.partialName(name))).toBe(false);
    expect(Archives.parseArchiveName(name)).toEqual(Option.some({ trigger, takenAt: at }));
  });

  it.prop("never name anything outside the folder", [Schema.String], ([name]) => {
    if (Archives.isArchiveName(name)) {
      expect(name).not.toMatch(/[/\\]/u);
      expect(name.startsWith(".")).toBe(false);
      expect(name.endsWith(".zip")).toBe(true);
    }
  });

  it("refuse paths, hidden files, and other extensions", () => {
    for (const name of [
      "../movies-manual-2026-10-12T03-00-00-000Z.zip",
      "/etc/passwd.zip",
      "a/b.zip",
      "a\\b.zip",
      ".zip",
      "..zip",
      ".partial-movies.zip",
      "snapshot.tar",
      "",
    ]) {
      expect(Archives.isArchiveName(name), name).toBe(false);
    }

    expect(Archives.isArchiveName("snapshot_1791828740404486415.zip")).toBe(true);
  });

  it("describe a copied-in archive as manual, taken at its modification time", () => {
    expect(Archives.describeArchive("snapshot.zip", 42, 1_000.7)).toEqual({
      fileName: "snapshot.zip",
      sizeBytes: 42,
      trigger: "manual",
      takenAt: 1_000,
    });

    const nightly = Archives.archiveName("nightly", 5_000);

    expect(Archives.describeArchive(nightly, 1, 9_999).takenAt).toBe(5_000);
    expect(Archives.describeArchive(nightly, 1, 9_999).trigger).toBe("nightly");
  });
});

describe("retention", () => {
  it.prop(
    "removes exactly the archives older than the window, never the one kept",
    [
      Schema.Array(Instant),
      Instant,
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
    ],
    ([times, now, days]) => {
      const archives = times.map((at, index) => archive(`a${String(index)}.zip`, at));
      const keep = archives[0]?.fileName ?? "none.zip";
      const expired = Archives.expiredArchives(archives, now, Duration.days(days), keep);

      for (const candidate of archives) {
        const old = candidate.takenAt < now - days * DAY_MS;

        expect(expired.includes(candidate)).toBe(old && candidate.fileName !== keep);
      }
    },
  );

  it("keeps fourteen days by default boundaries", () => {
    const now = 100 * DAY_MS;
    const fresh = archive("fresh.zip", now - 14 * DAY_MS);
    const stale = archive("stale.zip", now - 14 * DAY_MS - 1);

    expect(Archives.expiredArchives([fresh, stale], now, Duration.days(14), "new.zip")).toEqual([
      stale,
    ]);
  });
});

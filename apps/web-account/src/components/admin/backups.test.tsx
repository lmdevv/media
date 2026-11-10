import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { BackupsView, formatBytes, takenLabel } from "./backups";
import type { Paged } from "@media/ui/lib/pages";
import { disabledButton, loaded, noop, textOf } from "./testing";
import type { Backup } from "./types";

const backupId = Brand.nominal<Backup["id"]>();

const NOW = new Date(2026, 10, 10, 12).getTime();

const nightly: Backup = {
  id: backupId("b1"),
  fileName: "movies-nightly-2026-11-10T03-00-00-000Z.zip",
  sizeBytes: 182_000_000,
  trigger: "nightly",
  takenAt: new Date(2026, 10, 10, 3).getTime(),
};

const manual: Backup = {
  id: backupId("b2"),
  fileName: "movies-manual-2026-11-01T09-30-00-000Z.zip",
  sizeBytes: 4_100_000_000,
  trigger: "manual",
  takenAt: new Date(2026, 10, 1, 9, 30).getTime(),
};

const backups = (
  list: Paged<Backup>,
  selected: Backup | null = null,
  running: "run" | "restore" | null = null,
) => (
  <BackupsView
    backups={list}
    selected={selected}
    running={running}
    now={NOW}
    onBackUp={noop}
    onSelect={noop}
    onRestore={noop}
  />
);

describe("formatBytes", () => {
  it("writes decimal units with a decimal from GB up", () => {
    expect(formatBytes(182_000_000)).toBe("182 MB");
    expect(formatBytes(4_100_000_000)).toBe("4.1 GB");
    expect(formatBytes(0)).toBe("0 B");
  });
});

describe("takenLabel", () => {
  it("names today and yesterday", () => {
    expect(takenLabel(nightly.takenAt, NOW)).toMatch(/ · today$/u);
    expect(takenLabel(new Date(2026, 10, 9, 3).getTime(), NOW)).toMatch(/ · yesterday$/u);
    expect(takenLabel(manual.takenAt, NOW)).not.toContain(" · ");
  });
});

describe("BackupsView", () => {
  it("shows the schedule and says when there is no backup", () => {
    const text = textOf(backups(loaded([])));

    expect(text).toContain("Schedule Nightly · 03:00 UTC");
    expect(text).toContain("No backups yet.");
  });

  it("lists each backup with its kind, size, and file, and how many are kept", () => {
    const text = textOf(backups(loaded([nightly, manual])));

    expect(text).toContain(`Scheduled · 182 MB · ${nightly.fileName}`);
    expect(text).toContain(`Manual · 4.1 GB · ${manual.fileName}`);
    expect(text).toContain("2 kept · oldest");
  });

  it("counts the kept backups only once every page is loaded", () => {
    expect(textOf(backups(loaded([nightly], true)))).not.toContain("kept");
  });

  it("warns that everyone signs in again before restoring", () => {
    const text = textOf(backups(loaded([nightly, manual]), manual));

    expect(text).toContain("is replaced, and everyone signs in again while the server restarts.");
    expect(text).toContain("Cancel Restore and restart");
  });

  it("waits while a backup starts", () => {
    expect(disabledButton(backups(loaded([nightly]), null, "run"), "Restore…")).toBe(true);
    expect(textOf(backups(loaded([nightly]), null, "run"))).toContain("Backing up…");
  });
});

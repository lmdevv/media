import { describe, expect, it } from "vitest";

import { downloadRows } from "./download-row";
import { formatBytes } from "./format";

const cancel = (subtitle: string) => ({
  action: "remove",
  icon: "remove",
  title: "Cancel download",
  subtitle,
});

const removeSubtitle = (bytes: number, freedBytes: number) =>
  downloadRows({ kind: "downloaded", bytes }, true, freedBytes, "iPad")[0]?.subtitle;

describe("downloadRows", () => {
  it("offers Download, and says why not while the server is away", () => {
    expect(downloadRows({ kind: "none" }, true, 0, "iPhone")).toEqual([
      { action: "download", icon: "download", title: "Download", subtitle: null },
    ]);

    expect(downloadRows({ kind: "none" }, false, 0, "iPhone")).toEqual([
      {
        action: "none",
        icon: "download",
        title: "Download",
        subtitle: "Downloads need a connection to the server",
      },
    ]);
  });

  it("cancels a download still coming, with its progress", () => {
    expect(downloadRows({ kind: "downloading", done: 4, total: 9 }, true, 0, "iPhone")).toEqual([
      {
        action: "remove",
        icon: "remove",
        title: "Cancel download",
        subtitle: "Downloading 4 of 9",
      },
    ]);
  });

  it("offers Retry above Cancel once songs failed", () => {
    expect(downloadRows({ kind: "failed", failed: 2, total: 9 }, true, 0, "iPhone")).toEqual([
      {
        action: "retry",
        icon: "retry",
        title: "Retry download",
        subtitle: "Couldn’t download 2 of 9",
      },
      { action: "remove", icon: "remove", title: "Cancel download", subtitle: null },
    ]);
  });

  it("removes a finished download and says what it frees, as Paper's C08 row does", () => {
    expect(
      downloadRows({ kind: "downloaded", bytes: 1_400_000_000 }, true, 1_400_000_000, "iPhone"),
    ).toEqual([
      {
        action: "remove",
        icon: "remove",
        title: "Remove download",
        subtitle: "Frees 1.4 GB on this iPhone",
      },
    ]);
  });

  it("frees only what no other download keeps", () => {
    expect(downloadRows({ kind: "downloaded", bytes: 1_400_000_000 }, true, 0, "iPhone")).toEqual([
      {
        action: "remove",
        icon: "remove",
        title: "Remove download",
        subtitle: "Stays on this iPhone with your other downloads",
      },
    ]);

    expect(
      downloadRows({ kind: "downloaded", bytes: 412_000_000 }, true, 358_000_000, "iPhone"),
    ).toEqual([
      {
        action: "remove",
        icon: "remove",
        title: "Remove download",
        subtitle: "Frees 358 MB on this iPhone",
      },
    ]);

    expect(downloadRows({ kind: "downloaded", bytes: 0 }, true, 0, "iPhone")).toEqual([
      {
        action: "remove",
        icon: "remove",
        title: "Remove download",
        subtitle: "Takes no space on this iPhone",
      },
    ]);
  });

  it("waits for space on this device", () => {
    expect(downloadRows({ kind: "waiting", reason: "space" }, true, 0, "iPhone")).toEqual([
      cancel("Waiting for space on this iPhone"),
    ]);

    expect(downloadRows({ kind: "waiting", reason: "space" }, true, 0, "iPad")).toEqual([
      cancel("Waiting for space on this iPad"),
    ]);
  });

  it("names an iPad where it says what removing a download frees", () => {
    expect(removeSubtitle(412_000_000, 358_000_000)).toBe("Frees 358 MB on this iPad");
    expect(removeSubtitle(412_000_000, 0)).toBe("Stays on this iPad with your other downloads");
    expect(removeSubtitle(0, 0)).toBe("Takes no space on this iPad");
  });

  it("leaves a song its album keeps alone", () => {
    expect(
      downloadRows(
        { kind: "included", by: { kind: "album", title: "Blue Lines" } },
        false,
        0,
        "iPhone",
      ),
    ).toEqual([
      { action: "none", icon: "downloaded", title: "Downloaded", subtitle: "With Blue Lines" },
    ]);
  });
});

describe("formatBytes", () => {
  it("writes sizes in decimal units, as iOS Settings does", () => {
    expect(formatBytes(850_000)).toBe("850 KB");
    expect(formatBytes(412_300_000)).toBe("412 MB");
    expect(formatBytes(2_400_000_000)).toBe("2.4 GB");
    expect(formatBytes(999_600_000)).toBe("1 GB");
  });
});

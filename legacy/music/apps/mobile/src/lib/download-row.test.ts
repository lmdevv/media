import { describe, expect, it } from "vitest";

import { downloadRows } from "./download-row";
import { formatBytes } from "./format";

describe("downloadRows", () => {
  it("offers Download, and says why not while the server is away", () => {
    expect(downloadRows({ kind: "none" }, true)).toEqual([
      { action: "download", icon: "download", title: "Download", subtitle: null },
    ]);

    expect(downloadRows({ kind: "none" }, false)).toEqual([
      {
        action: "none",
        icon: "download",
        title: "Download",
        subtitle: "Downloads need a connection to the server",
      },
    ]);
  });

  it("cancels a download still coming, with its progress", () => {
    expect(downloadRows({ kind: "downloading", done: 4, total: 9 }, true)).toEqual([
      {
        action: "remove",
        icon: "remove",
        title: "Cancel download",
        subtitle: "Downloading 4 of 9",
      },
    ]);
  });

  it("offers Retry above Cancel once songs failed", () => {
    expect(downloadRows({ kind: "failed", failed: 2, total: 9 }, true)).toEqual([
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
    expect(downloadRows({ kind: "downloaded", bytes: 1_400_000_000 }, true)).toEqual([
      {
        action: "remove",
        icon: "remove",
        title: "Remove download",
        subtitle: "Frees 1.4 GB on this iPhone",
      },
    ]);
  });

  it("leaves a song its album keeps alone", () => {
    expect(
      downloadRows({ kind: "included", by: { kind: "album", title: "Blue Lines" } }, false),
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

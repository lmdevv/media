import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { downloadControl, removeAllCopy, removeDownloadCopy } from "./download-control";

describe("downloadControl", () => {
  it("downloads from the idle ring, and does nothing while the server is away", () => {
    expect(downloadControl({ kind: "none" }, true)).toEqual({
      ring: { kind: "idle" },
      press: "download",
      label: "Download",
    });

    expect(downloadControl({ kind: "none" }, false)).toEqual({
      ring: { kind: "idle" },
      press: "none",
      label: "Download, needs a connection to the server",
    });
  });

  it("cancels while songs are still coming, waiting or not", () => {
    expect(downloadControl({ kind: "queued" }, true).press).toBe("cancel");
    expect(downloadControl({ kind: "waiting", reason: "space" }, true)).toMatchObject({
      ring: { kind: "waiting" },
      press: "cancel",
    });

    expect(downloadControl({ kind: "downloading", done: 4, total: 9 }, true)).toEqual({
      ring: { kind: "downloading", progress: 4 / 9 },
      press: "cancel",
      label: "Cancel download, 4 of 9 songs downloaded",
    });
  });

  it("asks before removing a finished download, failed songs and all, as D04 and D05 draw it", () => {
    expect(downloadControl({ kind: "downloaded", bytes: 1 }, true)).toMatchObject({
      ring: { kind: "downloaded" },
      press: "confirm-remove",
    });

    expect(downloadControl({ kind: "failed", failed: 1, total: 9 }, true)).toMatchObject({
      ring: { kind: "downloaded" },
      press: "confirm-remove",
    });
  });

  it("never calls a download with no songs here downloaded", () => {
    expect(downloadControl({ kind: "failed", failed: 9, total: 9 }, true)).toEqual({
      ring: { kind: "waiting" },
      press: "cancel",
      label: "Cancel download, 9 songs couldn’t download",
    });
  });

  it("says what removing a download frees, and doesn't name a size before songs arrive", () => {
    expect(
      removeDownloadCopy("Blue Lines", "album", { bytes: 412_000_000, freedBytes: 412_000_000 }),
    ).toEqual({
      body: "Blue Lines and the 412 MB it takes leave this iPhone. Nothing changes on your server, and you can download it again any time.",
      confirmLabel: "Remove 412 MB",
    });

    expect(
      removeDownloadCopy("Blue Lines", "album", { bytes: 0, freedBytes: 0 }).confirmLabel,
    ).toBe("Remove download");
  });

  it("frees only what no other download keeps", () => {
    expect(
      removeDownloadCopy("Blue Lines", "album", { bytes: 412_000_000, freedBytes: 358_000_000 }),
    ).toEqual({
      body: "Blue Lines leaves your downloads and frees 358 MB. Songs your other downloads keep stay on this iPhone. Nothing changes on your server, and you can download it again any time.",
      confirmLabel: "Remove 358 MB",
    });

    expect(removeDownloadCopy("Teardrop", "track", { bytes: 54_000_000, freedBytes: 0 })).toEqual({
      body: "Teardrop leaves your downloads, and stays on this iPhone with your other downloads. Nothing changes on your server, and you can download it again any time.",
      confirmLabel: "Remove download",
    });

    expect(
      removeDownloadCopy("Blue Lines", "album", { bytes: 412_000_000, freedBytes: 0 }).body,
    ).toBe(
      "Blue Lines leaves your downloads. Its songs stay on this iPhone with your other downloads. Nothing changes on your server, and you can download it again any time.",
    );
  });

  it("says what removing every download frees, as D17 does", () => {
    expect(removeAllCopy({ tracks: 55, bytes: 2_400_000_000, freeBytes: null })).toEqual({
      body: "55 songs and 2.4 GB leave this iPhone. Nothing changes on your server, and you can download them again any time.",
      confirmLabel: "Remove 2.4 GB",
    });

    expect(removeAllCopy({ tracks: 0, bytes: 0, freeBytes: null }).confirmLabel).toBe(
      "Remove all downloads",
    );
  });

  it("fills the ring by songs finished, from empty to full", () => {
    fc.assert(
      fc.property(fc.nat(500), fc.nat(500), (a, b) => {
        const [done, total] = a <= b ? [a, b] : [b, a];
        const { ring } = downloadControl({ kind: "downloading", done, total }, true);

        expect(ring.kind === "downloading" && ring.progress >= 0 && ring.progress <= 1).toBe(true);
      }),
    );
  });
});

import { fsPathsOverlap } from "@music/commands/folder-ids";
import { describe, expect, it } from "vitest";

import { fsPathOf, parseMountinfo } from "./mounts.ts";

// A container: the root file system, /music from the host's disk (8:1, folder /srv/media), and
// a subfolder of one library bound again at /music/x, as `-v /srv/media/a/sub:/music/x` does.
const MOUNTINFO = [
  "21 1 0:50 / / rw,relatime - overlay overlay rw",
  "22 21 0:51 / /proc rw - proc proc rw",
  "30 21 8:1 /srv/media /music rw,relatime - ext4 /dev/sda1 rw",
  "31 30 8:1 /srv/media/a/sub /music/x rw,relatime - ext4 /dev/sda1 rw",
  "32 30 8:1 /srv/media/with\\040space /music/spaced rw - ext4 /dev/sda1 rw",
  "not a mountinfo line",
  "",
].join("\n");

const mounts = parseMountinfo(MOUNTINFO);

describe("fsPathOf", () => {
  it("names a folder by its file system and its path there", () => {
    expect(fsPathOf(mounts, "/music/a")).toBe("8:1:/srv/media/a");
    expect(fsPathOf(mounts, "/music")).toBe("8:1:/srv/media");
    expect(fsPathOf(mounts, "/music/x")).toBe("8:1:/srv/media/a/sub");
    expect(fsPathOf(mounts, "/music/x/deeper")).toBe("8:1:/srv/media/a/sub/deeper");
    expect(fsPathOf(mounts, "/data")).toBe("0:50:/data");
    expect(fsPathOf(mounts, "/")).toBe("0:50:/");
    expect(fsPathOf(mounts, "/music/spaced")).toBe("8:1:/srv/media/with space");
  });

  it("sees a bind mount of a library's subfolder as inside that library", () => {
    const a = fsPathOf(mounts, "/music/a");
    const x = fsPathOf(mounts, "/music/x");

    if (a === null || x === null) throw new Error("No mount covers the libraries");

    expect(fsPathsOverlap(a, x)).toBe(true);
    expect(fsPathsOverlap(x, a)).toBe(true);
  });

  it("tells folders side by side, and other file systems, apart", () => {
    const b = fsPathOf(mounts, "/music/b");
    const x = fsPathOf(mounts, "/music/x");
    const data = fsPathOf(mounts, "/data/a/sub");

    if (b === null || x === null || data === null) throw new Error("No mount covers them");

    expect(fsPathsOverlap(b, x)).toBe(false);
    expect(fsPathsOverlap(data, x)).toBe(false);
  });

  it("lets a later mount over a parent folder hide an earlier one deeper down", () => {
    const stacked = parseMountinfo(
      [
        "21 1 0:50 / / rw - overlay overlay rw",
        // /music/x was bound first, then a whole other disk mounted over /music.
        "30 21 8:1 /srv/media/a/sub /music/x rw - ext4 /dev/sda1 rw",
        "31 21 8:2 /other /music rw - ext4 /dev/sdb1 rw",
      ].join("\n"),
    );

    expect(fsPathOf(stacked, "/music/x")).toBe("8:2:/other/x");
    expect(fsPathOf(stacked, "/music")).toBe("8:2:/other");
  });

  it("covers nothing without mounts", () => {
    expect(fsPathOf([], "/music")).toBeNull();
  });
});

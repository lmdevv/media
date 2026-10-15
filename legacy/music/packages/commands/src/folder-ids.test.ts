import { describe, expect, it } from "vitest";

import { chainsOverlap, fsPathsOverlap } from "./folder-ids";

// Chains as the media service builds them: the folder first, then each parent up to `/`.
const [root, srv, music, rock, jazz] = ["1:2", "1:10", "1:11", "1:12", "1:13"];

// The same folder as `music`, reached through a bind mount at another path.
const bound = [music, "1:20", root];

describe("chainsOverlap", () => {
  it("finds the same folder by any name, and a folder inside or around another", () => {
    expect(chainsOverlap([music, srv, root], bound)).toBe(true);
    expect(chainsOverlap([rock, music, srv, root], bound)).toBe(true);
    expect(chainsOverlap([srv, root], [rock, music, srv, root])).toBe(true);
  });

  it("lets folders side by side and empty chains through", () => {
    expect(chainsOverlap([rock, music, srv, root], [jazz, music, srv, root])).toBe(false);
    expect(chainsOverlap([], [music, srv, root])).toBe(false);
  });
});

describe("fsPathsOverlap", () => {
  it("finds the same folder, and one inside another, on one file system", () => {
    expect(fsPathsOverlap("8:1:/srv/a", "8:1:/srv/a")).toBe(true);
    expect(fsPathsOverlap("8:1:/srv/a", "8:1:/srv/a/sub")).toBe(true);
    expect(fsPathsOverlap("8:1:/srv/a/sub", "8:1:/srv/a")).toBe(true);
    expect(fsPathsOverlap("8:1:/", "8:1:/srv")).toBe(true);
  });

  it("keeps folders side by side, look-alike names, and other file systems apart", () => {
    expect(fsPathsOverlap("8:1:/srv/a", "8:1:/srv/b")).toBe(false);
    expect(fsPathsOverlap("8:1:/srv/a", "8:1:/srv/ab")).toBe(false);
    expect(fsPathsOverlap("8:1:/srv/a", "8:2:/srv/a")).toBe(false);
    expect(fsPathsOverlap("", "8:1:/srv/a")).toBe(false);
  });
});

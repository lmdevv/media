/** Library folder paths: normalising them, and refusing a library that overlaps another. */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { normaliseLibraryPath, overlapOf } from "../convex/lib/paths";
import { failureCode } from "./harness";
import { makeBackend, signUp } from "./backend";

const segment = fc.stringMatching(/^[a-z0-9 ._-]{1,8}$/u).filter((part) => !/^\.+$/u.test(part));

/** An absolute, normalised path of zero or more plain segments. */
const plainPath = fc.array(segment, { maxLength: 5 }).map((parts) => `/${parts.join("/")}`);

describe("normaliseLibraryPath", () => {
  it("cleans up slashes, dot segments, and the trailing slash", () => {
    expect(normaliseLibraryPath("/music/")).toBe("/music");
    expect(normaliseLibraryPath("//music//rock/./")).toBe("/music/rock");
    expect(normaliseLibraryPath("/music/rock/../jazz")).toBe("/music/jazz");
    expect(normaliseLibraryPath("/../..")).toBe("/");
    expect(normaliseLibraryPath("music")).toBeNull();
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = normaliseLibraryPath(`/${raw}`);

        expect(once).not.toBeNull();
        expect(normaliseLibraryPath(once ?? "")).toBe(once);
      }),
    );
  });

  it("leaves a plain path as it is", () => {
    fc.assert(fc.property(plainPath, (path) => normaliseLibraryPath(path) === path));
  });
});

describe("overlapOf", () => {
  it("sees a folder inside another one, and the reverse", () => {
    fc.assert(
      fc.property(plainPath, fc.array(segment, { minLength: 1, maxLength: 3 }), (outer, rest) => {
        const inner = normaliseLibraryPath(`${outer}/${rest.join("/")}`) ?? "";

        return overlapOf(inner, outer) === "inside" && overlapOf(outer, inner) === "contains";
      }),
    );
  });

  it("is symmetric", () => {
    const flipped = { same: "same", inside: "contains", contains: "inside", apart: "apart" };

    fc.assert(
      fc.property(plainPath, plainPath, (left, right) => {
        expect(overlapOf(right, left)).toBe(flipped[overlapOf(left, right)]);
      }),
    );
  });

  it("compares whole segments", () => {
    expect(overlapOf("/music2", "/music")).toBe("apart");
    expect(overlapOf("/music", "/")).toBe("inside");
  });
});

describe("libraries.create", () => {
  it("refuses a folder that is, is inside, or contains another library's folder", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const other = await signUp(backend, "admin");

    await admin.music.run("libraries.create", { name: "Music", path: "/srv/music/" });
    await other.music.run("libraries.create", {
      name: "Secret",
      path: "/srv/secret",
      visibility: "private",
    });

    const create = (path: string) =>
      failureCode(admin.music.run("libraries.create", { name: "New", path }));

    expect(await create("/srv/music")).toBe("conflict");
    expect(await create("/srv//music/./rock")).toBe("conflict");
    expect(await create("/srv")).toBe("conflict");
    expect(await create("/srv/music2")).toBe("succeeded");

    // Another admin's private library stays anonymous: neither folder is named.
    await expect(
      admin.music.run("libraries.create", { name: "New", path: "/srv/secret/x" }),
    ).rejects.toThrow(/"message":"This folder overlaps another library"\}/u);

    // The other admin's private library is listed, unreadable and without its folder.
    expect(
      (await admin.music.read("libraries.list", {})).map((library) => [
        library.path,
        library.readable,
      ]),
    ).toEqual([
      ["/srv/music", true],
      [null, false],
      ["/srv/music2", true],
    ]);
  });
});

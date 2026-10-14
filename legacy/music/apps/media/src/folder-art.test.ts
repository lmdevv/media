import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { folderArtKey, folderArtLookup, isFolderArt } from "./folder-art.ts";

const art = (relativePath: string, size = 100, mtimeMs = 1000.5) => ({
  relativePath,
  size,
  mtimeMs,
});

describe("isFolderArt", () => {
  it("accepts cover, folder, and front images in any case, and nothing else", () => {
    for (const name of ["cover.jpg", "Cover.JPEG", "folder.png", "FRONT.webp"]) {
      expect(isFolderArt(name)).toBe(true);
    }

    for (const name of ["cover.gif", "back.jpg", "cover.jpg.bak", "my cover.jpg", "cover.flac"]) {
      expect(isFolderArt(name)).toBe(false);
    }
  });
});

describe("folderArtLookup", () => {
  it("prefers cover over folder over front in the song's own folder", () => {
    const lookup = folderArtLookup([
      art("Album/front.jpg"),
      art("Album/folder.png"),
      art("Album/cover.webp"),
      art("Other/front.jpg"),
    ]);

    expect(lookup("Album")?.relativePath).toBe("Album/cover.webp");
    expect(lookup("Other")?.relativePath).toBe("Other/front.jpg");
    expect(lookup("Elsewhere")).toBeUndefined();
  });

  it("gives disc folders the album folder's artwork, and other subfolders nothing", () => {
    const lookup = folderArtLookup([art("Album/cover.jpg"), art("Boxed/CD2/cover.png")]);

    for (const disc of ["CD1", "cd 2", "Disc 01", "disk-3", "Disc 2 - Bonus", "DISC_4"]) {
      expect(lookup(`Album/${disc}`)?.relativePath).toBe("Album/cover.jpg");
    }

    for (const other of ["Extras", "CDs", "Discography"]) {
      expect(lookup(`Album/${other}`)).toBeUndefined();
    }

    // A disc folder with artwork of its own keeps it.
    expect(lookup("Boxed/CD2")?.relativePath).toBe("Boxed/CD2/cover.png");
    expect(lookup("Boxed/CD1")).toBeUndefined();
  });

  it("finds artwork at the library root, which has no parent to fall back to", () => {
    expect(folderArtLookup([art("cover.jpg")])(".")?.relativePath).toBe("cover.jpg");
    expect(folderArtLookup([])("CD1")).toBeUndefined();
  });

  it("finds a folder's own artwork whatever order the walk listed it in", () => {
    const names = ["cover.jpg", "folder.jpg", "front.jpg"];

    fc.assert(
      fc.property(fc.shuffledSubarray(names, { minLength: 1 }), (present) => {
        const expected = names.find((name) => present.includes(name));

        expect(folderArtLookup(present.map((name) => art(`A/${name}`)))("A")?.relativePath).toBe(
          `A/${expected ?? ""}`,
        );
      }),
    );
  });
});

describe("folderArtKey", () => {
  it("changes with the artwork's path, size, and whole-millisecond time", () => {
    expect(folderArtKey(art("A/cover.jpg", 100, 1000.9))).toBe("A/cover.jpg:100:1000");
    expect(folderArtKey(art("A/cover.jpg", 101, 1000.9))).not.toBe(
      folderArtKey(art("A/cover.jpg", 100, 1000.9)),
    );
    expect(folderArtKey(undefined)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { parseFolders } from "./library-folders";

describe("parseFolders", () => {
  it("names each folder after its last part", () => {
    expect(parseFolders([" /music ", "/mnt/nas/Jazz/", "/"])).toEqual({
      ok: true,
      folders: [
        { name: "music", path: "/music" },
        { name: "Jazz", path: "/mnt/nas/Jazz/" },
        { name: "Music", path: "/" },
      ],
    });
  });

  it("leaves out blank extra fields but needs the first", () => {
    expect(parseFolders(["/music", "  "])).toEqual({
      ok: true,
      folders: [{ name: "music", path: "/music" }],
    });
    expect(parseFolders([""])).toMatchObject({ ok: false, index: 0 });
  });

  it("points at the first relative or repeated folder", () => {
    expect(parseFolders(["/music", "music"])).toMatchObject({ ok: false, index: 1 });
    expect(parseFolders(["/music", "/books", "/music"])).toEqual({
      ok: false,
      index: 2,
      message: "This folder is already on the list.",
    });
  });
});

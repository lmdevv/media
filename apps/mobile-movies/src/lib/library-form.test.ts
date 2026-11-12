import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import {
  NEW_DRAFT,
  fieldNamedIn,
  folderProblem,
  shortFolder,
  draftOf,
  submission,
  withFolder,
} from "./library-form";
import type { LibraryDetail } from "./owner";

describe("library form", () => {
  it("edits a library's own name and folders, or one empty folder when the core hides them", () => {
    const library: LibraryDetail = {
      libraryId: Brand.nominal<LibraryDetail["libraryId"]>()("libraries_1"),
      name: "Shows",
      kind: "movies",
      level: "manage",
      items: 2,
      folders: ["/media/shows"],
      scan: null,
    };

    expect(draftOf(library)).toStrictEqual({ name: "Shows", folders: ["/media/shows"] });
    expect(draftOf({ ...library, folders: null }).folders).toStrictEqual([""]);
    expect(NEW_DRAFT).toStrictEqual({ name: "Movies", folders: [""] });
  });

  it("refuses empty, relative, and dotted folders before asking the server", () => {
    expect(folderProblem("")).toBe("Enter the folder’s path on the server.");
    expect(folderProblem("media/movies")).toContain("full path");
    expect(folderProblem("/media/../etc")).toContain(". or ..");
    expect(folderProblem("/media/movies/")).toBeNull();
  });

  it("finds the folder a refusal names by its whole path", () => {
    const folders = [
      { field: 0, path: "/media" },
      { field: 1, path: "/media/movies/" },
    ];

    expect(fieldNamedIn("/media/movies is inside another folder of this library", folders)).toBe(1);
    expect(fieldNamedIn("Another library already uses /media.", folders)).toBe(0);
    expect(fieldNamedIn("Add at least one folder", folders)).toBeNull();
  });

  it("shortens long folders to their last two parts", () => {
    expect(shortFolder("/home/zxcv/movies-demo/Movies/")).toBe("…/movies-demo/Movies");
    expect(shortFolder("/media/movies")).toBe("/media/movies");
  });

  it("sends a trimmed name and normalized folders", () => {
    const draft = withFolder({ ...NEW_DRAFT, name: "  Movies " }, 0, " /media//movies/ ");

    expect(submission(draft)).toStrictEqual({ name: "Movies", folders: ["/media/movies"] });
    expect(submission({ ...draft, folders: ["/a", " ", "/b/"] }).folders).toStrictEqual([
      "/a",
      "/b",
    ]);
  });
});

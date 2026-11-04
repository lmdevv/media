import { LibraryId, UserId } from "@music/commands/ids";
import type { Library, LibraryMember, Person } from "@music/commands/models";
import { describe, expect, it } from "vitest";

import {
  accessCandidates,
  accessNote,
  folderProblem,
  libraryAdminLine,
  librariesSummary,
  nameFromFolder,
  visibilityCallout,
  visibilityChoices,
} from "./libraries";

const library = (fields: Partial<Library> = {}): Library => ({
  id: LibraryId.make("music"),
  name: "Personal collection",
  path: "/music",
  manageable: true,
  accessControl: "full",
  visibility: "shared",
  ownerId: UserId.make("lee"),
  ownerName: "Lee",
  readable: true,
  trackCount: 1106,
  lastScanAt: null,
  scanning: false,
  ...fields,
});

const person = (id: string, role: Person["role"]): Person => ({
  id: UserId.make(id),
  email: `${id}@example.com`,
  name: id,
  role,
  suspended: false,
  createdAt: 0,
  lastActiveAt: null,
  joinedViaJam: false,
});

const member = (id: string): LibraryMember => ({
  id: UserId.make(id),
  email: `${id}@example.com`,
  name: id,
  role: "member",
});

describe("libraryAdminLine", () => {
  it("says the folder, who listens, and its size as F14 does", () => {
    expect(libraryAdminLine(library(), "lee")).toBe("/music · Shared · 1,106 songs");
    expect(
      libraryAdminLine(library({ visibility: "private", path: "/vinyl", trackCount: 142 }), "lee"),
    ).toBe("/vinyl · Only you · 142 songs");
  });

  it("names another owner, and leaves out a hidden folder", () => {
    expect(
      libraryAdminLine(library({ visibility: "private", path: null, trackCount: 1 }), "sam"),
    ).toBe("Only Lee · 1 song");
    expect(libraryAdminLine(library({ visibility: "restricted" }), "lee")).toBe(
      "/music · Restricted · 1,106 songs",
    );
  });
});

describe("librariesSummary", () => {
  it("counts folders and their songs", () => {
    expect(librariesSummary([library(), library({ trackCount: 142 })])).toBe(
      "2 folders · 1,248 songs",
    );
    expect(librariesSummary([])).toBe("0 folders · 0 songs");
  });
});

const values = (choices: ReadonlyArray<{ readonly value: string }>) =>
  choices.map((choice) => choice.value);

describe("visibilityChoices", () => {
  it("offers every choice to the library's owner", () => {
    expect(values(visibilityChoices("full", "private"))).toEqual([
      "shared",
      "restricted",
      "private",
    ]);
  });

  it("offers only narrower choices to the server owner standing in", () => {
    expect(values(visibilityChoices("narrow", "restricted"))).toEqual(["restricted", "private"]);
    expect(values(visibilityChoices("narrow", "private"))).toEqual(["private"]);
  });

  it("offers nothing to anyone else", () => {
    expect(visibilityChoices("none", "shared")).toEqual([]);
  });
});

describe("visibility copy", () => {
  it("speaks to the owner, or names them", () => {
    expect(visibilityCallout("restricted", "you").body).toBe(
      "Only you and people you add can listen. Only the library owner can change access.",
    );
    expect(visibilityCallout("private", "Sam").body).toBe("Only Sam can listen.");
  });

  it("explains limited control, and says nothing for full control", () => {
    expect(accessNote("full", "you")).toBeNull();
    expect(accessNote("none", "Sam")).toBe("Only Sam can change who listens.");
    expect(accessNote("narrow", "Sam")).toContain("only let fewer people listen");
  });
});

describe("accessCandidates", () => {
  const people = [
    person("lee", "owner"),
    person("sam", "admin"),
    person("alex", "member"),
    person("riley", "guest"),
  ];

  it("offers everyone not yet on a restricted library's list, except its owner", () => {
    const restricted = library({ visibility: "restricted" });

    expect(accessCandidates(people, [member("sam")], restricted).map((p) => p.id)).toEqual([
      "alex",
      "riley",
    ]);
  });

  it("offers only guests for a shared library, and nobody for a private one", () => {
    expect(accessCandidates(people, [], library()).map((p) => p.id)).toEqual(["riley"]);
    expect(accessCandidates(people, [], library({ visibility: "private" }))).toEqual([]);
  });
});

describe("folders", () => {
  it("takes only absolute paths", () => {
    expect(folderProblem("/archive")).toBeNull();
    expect(folderProblem("archive")).toContain("starts with /");
    expect(folderProblem("")).toContain("Enter a folder");
  });

  it("names a library after its folder", () => {
    expect(nameFromFolder("/srv/Archive/")).toBe("Archive");
    expect(nameFromFolder("/")).toBe("Music");
  });
});

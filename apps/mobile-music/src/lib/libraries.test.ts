import { describe, expect, it } from "vitest";

import {
  folderProblem,
  librariesSummary,
  libraryAdminLine,
  nameFromFolder,
  reachCallout,
} from "./libraries";

describe("libraries", () => {
  it("reads a library's folder and songs, leaving out what the core hides", () => {
    expect(libraryAdminLine({ folders: ["/music"], items: 1106 })).toBe("/music · 1,106 songs");
    expect(libraryAdminLine({ folders: null, items: null })).toBe("");
  });

  it("sums the songs of every library you manage", () => {
    expect(librariesSummary([{ items: 2 }, { items: null }, { items: 1 }])).toBe(
      "3 libraries · 3 songs",
    );
  });

  it("asks for an absolute folder and names a library after it", () => {
    expect(folderProblem("")).toBe("Enter a folder on the server, such as /music.");
    expect(folderProblem("music")).toBe("Use a full path that starts with /, such as /music.");
    expect(folderProblem("/music")).toBeNull();
    expect(nameFromFolder("/srv/Archive/")).toBe("Archive");
    expect(nameFromFolder("/")).toBe("Music");
  });

  it("explains who listens to a shared and a private library", () => {
    expect(reachCallout("shared").title).toBe("Shared library");
    expect(reachCallout("private").body).toContain("admins included");
  });
});

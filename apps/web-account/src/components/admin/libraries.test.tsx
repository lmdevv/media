import { Brand } from "effect";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { LibrariesView, foldersOf } from "./libraries";
import type { NewLibrary } from "./libraries";
import { LibraryView } from "./library";
import type { LibraryMode, LibraryState } from "./library";
import { SharingView } from "./sharing";
import type { Paged } from "@media/ui/lib/pages";
import { disabledButton, loaded, noop, textOf } from "./testing";
import type { Grant, Group, Library, LibraryDetail, LibraryId, User } from "./types";

const libraryId = Brand.nominal<LibraryId>();

const userId = Brand.nominal<User["userId"]>();

const groupId = Brand.nominal<Group["groupId"]>();

const jobId = Brand.nominal<NonNullable<LibraryDetail["scan"]>["jobId"]>();

const films: Library = {
  libraryId: libraryId("l1"),
  name: "Films",
  kind: "movies",
  level: "manage",
};

const empty: NewLibrary = { name: "", kind: "movies", folders: "" };

const list = (libraries: Paged<Library>, draft: NewLibrary = empty) => (
  <LibrariesView
    libraries={libraries}
    draft={draft}
    creating={false}
    onDraft={noop}
    onCreate={noop}
    nameLink={(library) => <a href="#library">{library.name}</a>}
  />
);

describe("foldersOf", () => {
  it("keeps one trimmed folder per non-blank line", () => {
    expect(foldersOf(" /srv/films \n\n/srv/more\n")).toEqual(["/srv/films", "/srv/more"]);
  });
});

describe("LibrariesView", () => {
  it("lists libraries with their kind and level", () => {
    expect(textOf(list(loaded([films])))).toContain("Films Movies · Manages");
  });

  it("says when no library is shared with this admin", () => {
    expect(textOf(list(loaded([])))).toContain("No library is shared with you.");
  });

  it("adds a library only with a name and a folder", () => {
    expect(disabledButton(list(loaded([])), "Add library")).toBe(true);
    expect(disabledButton(list(loaded([]), { ...empty, name: "Films" }), "Add library")).toBe(true);
    expect(
      disabledButton(
        list(loaded([]), { ...empty, name: "Films", folders: "/srv/films" }),
        "Add library",
      ),
    ).toBe(false);
  });
});

const detail: LibraryDetail = {
  ...films,
  items: 12,
  folders: ["/srv/films"],
  scan: {
    jobId: jobId("j1"),
    status: "running",
    done: 3,
    total: 10,
    error: null,
    message: null,
    startedAt: 0,
    finishedAt: null,
  },
};

const library = (
  state: LibraryState,
  mode: LibraryMode = { kind: "idle" },
  sharing: ReactNode = null,
) => (
  <LibraryView
    state={state}
    mode={mode}
    running={null}
    sharing={sharing}
    back={<a href="#libraries">Libraries</a>}
    onMode={noop}
    onScan={noop}
    onRename={noop}
    onFolders={noop}
    onRemove={noop}
  />
);

describe("LibraryView", () => {
  it("shows a missing library and a failure", () => {
    expect(textOf(library({ kind: "missing" }))).toContain(
      "This library doesn't exist, or it isn't shared with you.",
    );
    expect(textOf(library({ kind: "failed", message: "Offline", retry: noop }))).toContain(
      "Offline Try again",
    );
  });

  it("shows a manager the scan, folders, sharing, and removal", () => {
    const text = textOf(
      library({ kind: "ready", library: detail }, { kind: "idle" }, <p>sharing part</p>),
    );

    expect(text).toContain("Films");
    expect(text).toContain("Movies · 12 items · Manages");
    expect(text).toContain("Scanning 3 of 10 files");
    expect(text).toContain("/srv/films Change folders");
    expect(text).toContain("sharing part");
    expect(text).toContain("Remove library");
    expect(disabledButton(library({ kind: "ready", library: detail }), "Scan now")).toBe(true);
  });

  it("shows a viewer only what the library holds", () => {
    const viewer: LibraryDetail = { ...detail, level: "view", folders: null, scan: null };

    const text = textOf(
      library({ kind: "ready", library: viewer }, { kind: "idle" }, <p>sharing part</p>),
    );

    expect(text).toContain("Never scanned");
    expect(text).not.toContain("Scan now");
    expect(text).not.toContain("Folders");
    expect(text).not.toContain("sharing part");
    expect(text).not.toContain("Remove library");
  });

  it("edits folders and asks before removing", () => {
    expect(
      textOf(library({ kind: "ready", library: detail }, { kind: "folders", text: "/srv/films" })),
    ).toContain("What a removed folder held leaves the library.");
    expect(textOf(library({ kind: "ready", library: detail }, { kind: "removing" }))).toContain(
      "Films and everything it lists are deleted. The files on disk stay. Cancel Remove",
    );
  });

  it("names a failed scan's error", () => {
    const failed: LibraryDetail = {
      ...detail,
      scan: {
        jobId: jobId("j2"),
        status: "failed",
        done: null,
        total: null,
        error: "Folder gone",
        message: null,
        startedAt: null,
        finishedAt: 1,
      },
    };

    expect(textOf(library({ kind: "ready", library: failed }))).toContain(
      "The last scan failed: Folder gone",
    );
  });
});

const sam: User = { userId: userId("u1"), username: "sam", role: "member" };

const kim: User = { userId: userId("u2"), username: "kim", role: "admin" };

const kids: Group = { groupId: groupId("g1"), name: "Kids" };

const grants: ReadonlyArray<Grant> = [
  { principal: { kind: "user", userId: sam.userId, username: "sam" }, level: "manage" },
  { principal: { kind: "household" }, level: "view" },
];

const sharing = (who: "" | "household" | `user:${string}` | `group:${string}` = "") => (
  <SharingView
    grants={loaded(grants)}
    users={[sam, kim]}
    groups={[kids]}
    adding={{ who, level: "view" }}
    running={null}
    onAdding={noop}
    onShare={noop}
    onLevel={noop}
    onRemove={noop}
  />
);

describe("SharingView", () => {
  it("lists each grant by who it reaches", () => {
    const text = textOf(sharing());

    expect(text).toContain("sam");
    expect(text).toContain("Everyone on this server");
  });

  it("offers only who it is not shared with yet", () => {
    const text = textOf(sharing());

    expect(text).toContain("Choose who Kids (group) kim");
    expect(text).not.toContain("Choose who Everyone");
  });

  it("lets only a person manage", () => {
    expect(textOf(sharing("group:g1"))).not.toContain("Can view Can edit Manages Share");
    expect(textOf(sharing("user:u2"))).toContain("Can view Can edit Manages Share");
  });

  it("shares once someone is chosen", () => {
    expect(disabledButton(sharing(), "Share")).toBe(true);
    expect(disabledButton(sharing("user:u2"), "Share")).toBe(false);
  });
});

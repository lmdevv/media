import type { Callout } from "./callout";
import type { LibraryView } from "./first-scan";
import { countOf } from "./format";

/**
 * Who can listen to a library you manage, as its grants say (ADR 0024): everyone on the server
 * (`shared`, a household grant), or only the people you add (`private`). A core library is private
 * to its maker until shared, admins included.
 */
export type LibraryReach = "shared" | "private";

/** A library row's subtitle (F14): `/music · 1,106 songs`; no folder when it is hidden. */
export const libraryAdminLine = (library: Pick<LibraryView, "folders" | "items">): string =>
  [
    ...(library.folders?.[0] === undefined ? [] : [library.folders[0]]),
    ...(library.items === null ? [] : [countOf(library.items, "song")]),
  ].join(" · ");

/** The hub's Libraries row (F08): `2 libraries · 1,248 songs`. */
export const librariesSummary = (libraries: ReadonlyArray<Pick<LibraryView, "items">>): string =>
  `${countOf(libraries.length, "library", "libraries")} · ${countOf(
    libraries.reduce((total, library) => total + (library.items ?? 0), 0),
    "song",
  )}`;

/** Who-can-listen choices in Paper's order (F15, F17). */
export const REACHES: ReadonlyArray<{ readonly value: LibraryReach; readonly label: string }> = [
  { value: "shared", label: "Shared" },
  { value: "private", label: "Private" },
];

/** What a reach means, for the callout under the chips (F15). */
export const reachCallout = (reach: LibraryReach): Callout =>
  reach === "shared"
    ? {
        title: "Shared library",
        body: "Everyone on the server can listen. Add people below to let them edit too.",
      }
    : {
        title: "Private library",
        body: "Only you and the people you add can listen. It’s hidden from everyone else, admins included.",
      };

/**
 * Why a typed folder can't be sent (F17), or null when it can: the server takes an absolute path.
 */
export const folderProblem = (path: string): string | null => {
  if (path.length === 0) return "Enter a folder on the server, such as /music.";

  return path.startsWith("/") ? null : "Use a full path that starts with /, such as /music.";
};

/** A name for a library from its folder when none was typed: `/srv/Archive/` gives `Archive`. */
export const nameFromFolder = (path: string): string =>
  path.split("/").findLast((part) => part.length > 0) ?? "Music";

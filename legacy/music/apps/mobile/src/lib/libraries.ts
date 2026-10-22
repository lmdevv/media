/**
 * Library folders as the administration screens word them (F08, F14–F17): row subtitles, who can
 * listen, which visibility choices someone may make, and who can still be added.
 */
import type {
  AccessControl,
  Library,
  LibraryMember,
  LibraryVisibility,
  Person,
} from "@music/commands/models";
import { widensVisibility } from "@music/commands/permissions";

import type { Callout } from "./callout";
import { countOf } from "./format";

/** How to name a library's owner in copy: `you`, or their name. */
export const libraryOwner = (library: Library, meId: string): string =>
  library.ownerId === meId ? "you" : (library.ownerName ?? "its owner");

/** Who can listen, as a short label (F14): `Shared`, `Restricted`, `Only you`, `Only Sam`. */
const visibilityLabel = (visibility: LibraryVisibility, owner: string): string => {
  if (visibility === "private") return `Only ${owner}`;

  return visibility === "shared" ? "Shared" : "Restricted";
};

/** A library row's subtitle (F14): `/music · Shared · 1,106 songs`; no path when it is hidden. */
export const libraryAdminLine = (library: Library, meId: string): string =>
  [
    ...(library.path === null ? [] : [library.path]),
    visibilityLabel(library.visibility, libraryOwner(library, meId)),
    countOf(library.trackCount, "song"),
  ].join(" · ");

/** The hub's Libraries row (F08): `2 folders · 1,248 songs`. */
export const librariesSummary = (libraries: ReadonlyArray<Library>): string =>
  `${countOf(libraries.length, "folder")} · ${countOf(
    libraries.reduce((total, library) => total + library.trackCount, 0),
    "song",
  )}`;

/** Visibility choices in Paper's order (F15, F17). */
export const VISIBILITIES: ReadonlyArray<{
  readonly value: LibraryVisibility;
  readonly label: string;
}> = [
  { value: "shared", label: "Shared" },
  { value: "restricted", label: "Restricted" },
  { value: "private", label: "Private" },
];

/**
 * The visibility choices `control` allows from the saved visibility: all of them for the
 * library's owner, only those that let no more people in for the server's owner standing in
 * (`narrow`), and none otherwise.
 */
export const visibilityChoices = (
  control: AccessControl,
  saved: LibraryVisibility,
): ReadonlyArray<{ readonly value: LibraryVisibility; readonly label: string }> => {
  if (control === "none") return [];

  if (control === "full") return VISIBILITIES;

  return VISIBILITIES.filter((choice) => !widensVisibility(saved, choice.value));
};

/** What a visibility means, for the callout under the chips (F15). `owner` is `you` or a name. */
export const visibilityCallout = (visibility: LibraryVisibility, owner: string): Callout => {
  const yours = owner === "you";

  if (visibility === "shared") {
    return {
      title: "Shared library",
      body: "Everyone on the server can listen, except guests. Add guests individually.",
    };
  }

  if (visibility === "restricted") {
    return {
      title: "Restricted library",
      body: yours
        ? "Only you and people you add can listen. Only the library owner can change access."
        : `Only ${owner} and people they add can listen. Only ${owner} can change access.`,
    };
  }

  return {
    title: "Private library",
    body: yours
      ? "Only you can listen. It’s hidden from other members and admins."
      : `Only ${owner} can listen.`,
  };
};

/**
 * Why someone can change who listens only partly, or not at all (F15); null for the library's
 * owner, who can change it any way.
 */
export const accessNote = (control: AccessControl, owner: string): string | null => {
  if (control === "full") return null;

  if (control === "narrow") {
    return `${owner} doesn’t run libraries now, so you can only let fewer people listen.`;
  }

  return `Only ${owner} can change who listens.`;
};

/**
 * Who can still be added to a library's access list (F16): not its owner, not someone already
 * on it, and, for a shared library that every member already hears, only guests.
 */
export const accessCandidates = (
  people: ReadonlyArray<Person>,
  members: ReadonlyArray<LibraryMember>,
  library: Pick<Library, "ownerId" | "visibility">,
): ReadonlyArray<Person> => {
  if (library.visibility === "private") return [];

  const added = new Set(members.map((member) => member.id));

  return people.filter(
    (person) =>
      person.id !== library.ownerId &&
      !added.has(person.id) &&
      (library.visibility === "restricted" || person.role === "guest"),
  );
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

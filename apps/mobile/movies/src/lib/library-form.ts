import { normalizeFolder } from "@media/contracts/library-folder";
import { fieldEdit } from "@media/mobile-core/edits";
import type { FieldEdit } from "@media/mobile-core/edits";

import type { LibraryDetail } from "./owner";

/** What the form holds. */
export interface LibraryDraft {
  readonly name: string;
  /** One or more folders; a new library starts with one. */
  readonly folders: ReadonlyArray<string>;
}

/**
 * A new library: named Movies, with one empty folder. The core keeps movies and shows in one kind
 * of library and tells them apart by their files, so the form has no kind to choose.
 */
export const NEW_DRAFT: LibraryDraft = { name: "Movies", folders: [""] };

/** The draft for editing `library`: its own name, and its folders when the core shows them. */
export const draftOf = (library: LibraryDetail): LibraryDraft => ({
  name: library.name,
  folders: library.folders === null || library.folders.length === 0 ? [""] : library.folders,
});

/** `draft` with folder `index` set to `folder`. */
export const withFolder = (draft: LibraryDraft, index: number, folder: string): LibraryDraft => ({
  ...draft,
  folders: draft.folders.map((current, at) => (at === index ? folder : current)),
});

/** Why a typed folder cannot be saved, or null when it looks valid. */
export const folderProblem = (path: string): string | null => {
  const folder = normalizeFolder(path);

  if (folder === "") return "Enter the folder’s path on the server.";

  if (!folder.startsWith("/")) return "Use the full path from the root, such as /media/movies.";

  const segments = folder.split("/");

  if (segments.includes(".") || segments.includes("..")) {
    return "Write the path without . or .. parts.";
  }

  return null;
};

/** The line shown under a folder the server cannot read (I17). */
export const UNAVAILABLE_FOLDER = "This folder isn’t available to the server.";

/**
 * The folders to check and send, by their field: the first always, the others once filled in, so
 * emptying an extra folder's field removes it.
 */
export const filledFolders = (
  draft: LibraryDraft,
): ReadonlyArray<{ readonly field: number; readonly path: string }> =>
  draft.folders.flatMap((path, field) =>
    field === 0 || path.trim() !== "" ? [{ field, path }] : [],
  );

/** The draft as the core takes it: a trimmed name and its filled folders, normalized. */
export const submission = (draft: LibraryDraft) => ({
  name: draft.name.trim(),
  folders: filledFolders(draft).map((folder) => normalizeFolder(folder.path)),
});

/**
 * A folder short enough for a row's detail: its last two parts after an ellipsis, such as
 * `…/movies-demo/Movies`, or the whole path when that is all it has, such as `/media/movies`.
 */
export const shortFolder = (path: string): string => {
  const parts = normalizeFolder(path)
    .split("/")
    .filter((part) => part !== "");

  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : normalizeFolder(path);
};

/**
 * The field of the folder a server refusal names, such as `/media/movies is inside /media, a
 * folder of the library "Movies"`: the first whole path in the message that is one of `folders`
 * exactly, so `/media` never claims an error about `/media/movies`. Null when it names none.
 */
export const fieldNamedIn = (
  message: string,
  folders: ReadonlyArray<{ readonly field: number; readonly path: string }>,
): number | null => {
  const paths = message.split(/[\s,"“”]+/u).map((word) => word.replace(/[.:;]+$/u, ""));

  for (const path of paths) {
    const named = folders.find((folder) => normalizeFolder(folder.path) === path);

    if (named !== undefined) return named.field;
  }

  return null;
};

/** The fields of a library its edit form changes, as the core holds them. */
export interface LibraryFields {
  readonly name: string;
  readonly folders: ReadonlyArray<string>;
}

/** `library`'s name and folders. */
export const fieldsOf = (library: LibraryDetail): LibraryFields => ({
  name: library.name,
  folders: library.folders ?? [],
});

/** What saving the edit form writes: each field the person changed, and only those. */
export interface LibrarySave {
  readonly name: FieldEdit<string>;
  readonly folders: FieldEdit<ReadonlyArray<string>>;
}

/**
 * The save of `draft`, with `began` as the library was when the form opened and `live` as it is
 * now. A field counts as edited only when the person changed it from `began`, so a rename never
 * writes back folders another admin changed meanwhile.
 */
export const librarySave = (
  began: LibraryFields,
  draft: LibraryDraft,
  live: LibraryFields,
): LibrarySave => {
  const sent = submission(draft);

  return {
    name: fieldEdit(began.name, sent.name, live.name),
    folders: fieldEdit(began.folders, sent.folders, live.folders),
  };
};

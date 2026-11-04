import type { LibraryDetail } from "@media/contracts/models/catalog";
import { normalizeFolder } from "@media/contracts/library-folder";

/** The kinds the form offers; `mixed` libraries come from imports and keep their kind. */
export type FormKind = "movies" | "shows";

/** What the form holds. */
export interface LibraryDraft {
  readonly name: string;
  readonly kind: FormKind;
  /** One or more folders; a new library starts with one. */
  readonly folders: ReadonlyArray<string>;
}

/** The kind chips' labels, which are also a new library's default names. */
export const KIND_LABELS: Readonly<Record<FormKind, string>> = {
  movies: "Movies",
  shows: "Shows",
};

/** A new library: Movies, named after its kind, with one empty folder. */
export const NEW_DRAFT: LibraryDraft = { name: KIND_LABELS.movies, kind: "movies", folders: [""] };

/** The draft for editing `library`: its own name and folders. */
export const draftOf = (library: LibraryDetail): LibraryDraft => ({
  name: library.name,
  kind: library.kind === "shows" ? "shows" : "movies",
  folders: library.roots.length === 0 ? [""] : library.roots,
});

/** `draft` with kind `kind`; a name still at the old kind's default follows to the new one. */
export const withKind = (draft: LibraryDraft, kind: FormKind): LibraryDraft => ({
  ...draft,
  kind,
  name: draft.name.trim() === KIND_LABELS[draft.kind] ? KIND_LABELS[kind] : draft.name,
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

/** The draft as the server takes it: a trimmed name and its filled folders, normalized. */
export const submission = (draft: LibraryDraft) => ({
  name: draft.name.trim(),
  roots: filledFolders(draft).map((folder) => normalizeFolder(folder.path)),
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

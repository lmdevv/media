import { usePlatform } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { TextField } from "@media/ui/components/text-field";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/shell";

import { useActions } from "./action";
import { usePages } from "./pages";
import type { Paged } from "./pages";
import { ItemRow, PagedList, Section, SelectField } from "./parts";
import type { Choice } from "./parts";
import type { Level, Library, LibraryKind } from "./types";

export const KIND_LABELS: Readonly<Record<LibraryKind, string>> = {
  movies: "Movies",
  music: "Music",
};

export const LEVEL_LABELS: Readonly<Record<Level, string>> = {
  view: "Can view",
  edit: "Can edit",
  manage: "Manages",
};

const KIND_CHOICES: ReadonlyArray<Choice<LibraryKind>> = [
  { value: "movies", label: "Movies" },
  { value: "music", label: "Music" },
];

/** The folders typed one per line, without blank lines. */
export const foldersOf = (text: string): Array<string> =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** A new library as the form holds it. */
export interface NewLibrary {
  readonly name: string;
  readonly kind: LibraryKind;
  readonly folders: string;
}

const EMPTY_LIBRARY: NewLibrary = { name: "", kind: "movies", folders: "" };

/** Libraries: the ones shared with this admin, and a form to make one from server folders. */
export function LibrariesScreen() {
  const platform = usePlatform();

  const libraries = usePages(platform.core.libraries.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const actions = useActions<"create">();
  const [draft, setDraft] = useState<NewLibrary>(EMPTY_LIBRARY);

  const create = async (): Promise<void> => {
    const name = draft.name.trim();

    const made = await actions.run(
      "create",
      () =>
        platform.core.libraries.create({
          name,
          kind: draft.kind,
          folders: foldersOf(draft.folders),
        }),
      `Created ${name}. Its first scan is queued.`,
    );

    if (made !== undefined) setDraft(EMPTY_LIBRARY);
  };

  return (
    <LibrariesView
      libraries={libraries}
      draft={draft}
      creating={actions.running === "create"}
      onDraft={setDraft}
      onCreate={() => void create()}
      nameLink={(library) => (
        <Link
          to="/admin/libraries/$libraryId"
          params={{ libraryId: library.libraryId }}
          className="hover:underline"
        >
          {library.name}
        </Link>
      )}
    />
  );
}

/** The libraries list and the new-library form. */
export function LibrariesView({
  libraries,
  draft,
  creating,
  onDraft,
  onCreate,
  nameLink,
}: {
  readonly libraries: Paged<Library>;
  readonly draft: NewLibrary;
  readonly creating: boolean;
  readonly onDraft: (draft: NewLibrary) => void;
  readonly onCreate: () => void;
  /** The library's name, linked to its page. */
  readonly nameLink: (library: Library) => ReactNode;
}) {
  const ready = draft.name.trim() !== "" && foldersOf(draft.folders).length > 0;

  return (
    <>
      <PageHeader title="Libraries" />
      <PagedList
        label="Libraries"
        list={libraries}
        empty="No library is shared with you."
        rowKey={(library) => library.libraryId}
      >
        {(library) => (
          <ItemRow
            title={nameLink(library)}
            facts={`${KIND_LABELS[library.kind]} · ${LEVEL_LABELS[library.level]}`}
          />
        )}
      </PagedList>
      <Section title="Add a library">
        <form
          className="flex flex-col gap-4 md:max-w-120"
          onSubmit={(event) => {
            event.preventDefault();

            if (ready) onCreate();
          }}
        >
          <TextField
            label="Name"
            value={draft.name}
            onChange={(event) => onDraft({ ...draft, name: event.target.value })}
          />
          <SelectField
            label="Kind"
            value={draft.kind}
            options={KIND_CHOICES}
            onChange={(kind) => onDraft({ ...draft, kind })}
          />
          <FoldersField
            value={draft.folders}
            onChange={(folders) => onDraft({ ...draft, folders })}
          />
          <div>
            <Button type="submit" size="xs" disabled={creating || !ready}>
              Add library
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}

/** Folders on the server, one absolute path per line. */
export function FoldersField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-sans text-label/4 font-medium text-text-muted">
        Folders, one per line
      </label>
      <textarea
        id={id}
        rows={3}
        spellCheck={false}
        value={value}
        placeholder="/srv/media/movies"
        onChange={(event) => onChange(event.target.value)}
        className="w-full min-w-0 rounded-control border border-hairline bg-surface-raised px-3.5 py-2.5 font-mono text-label/label text-text caret-accent placeholder:text-text-muted"
      />
    </div>
  );
}

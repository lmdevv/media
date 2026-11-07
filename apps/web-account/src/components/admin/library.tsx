import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { TextField } from "@media/ui/components/text-field";
import { Link, useNavigate } from "@tanstack/react-router";
import { Match } from "effect";
import { useState } from "react";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/shell";
import { describeFailure, isFailure } from "@/lib/failure";

import { useActions } from "./action";
import { FoldersField, KIND_LABELS, LEVEL_LABELS, foldersOf } from "./libraries";
import { Failed, Muted, Notice, Section, formatTime } from "./parts";
import { Sharing } from "./sharing";
import type { LibraryDetail, LibraryId } from "./types";

/** What the library page shows. */
export type LibraryState =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string; readonly retry: () => void }
  | { readonly kind: "ready"; readonly library: LibraryDetail };

/** What the library page is editing, if anything. */
export type LibraryMode =
  | { readonly kind: "idle" }
  | { readonly kind: "renaming"; readonly name: string }
  | { readonly kind: "folders"; readonly text: string }
  | { readonly kind: "removing" };

type LibraryAction = "rename" | "folders" | "scan" | "remove";

/** One library: its scan, name, folders, who it is shared with, and removing it. */
export function LibraryScreen({ libraryId }: { readonly libraryId: LibraryId }) {
  const platform = usePlatform();
  const libraries = platform.core.libraries;
  const navigate = useNavigate();
  const query = usePlatformQuery(libraries.get, { libraryId });
  const actions = useActions<LibraryAction>();
  const [mode, setMode] = useState<LibraryMode>({ kind: "idle" });

  const state = Match.value(query).pipe(
    Match.discriminatorsExhaustive("status")({
      loading: (): LibraryState => ({ kind: "loading" }),
      error: ({ error, retry }): LibraryState =>
        isFailure(error, "NotFound") || isFailure(error, "InvalidArgs")
          ? { kind: "missing" }
          : { kind: "failed", message: describeFailure(error), retry },
      success: ({ data }): LibraryState => ({ kind: "ready", library: data }),
    }),
  );

  const rename = async (name: string): Promise<void> => {
    const done = await actions.run(
      "rename",
      () => libraries.rename({ libraryId, name: name.trim() }),
      "Renamed",
    );

    if (done !== undefined) setMode({ kind: "idle" });
  };

  const changeFolders = async (text: string): Promise<void> => {
    const done = await actions.run(
      "folders",
      () => libraries.setFolders({ libraryId, folders: foldersOf(text) }),
      "Folders saved",
    );

    if (done !== undefined) setMode({ kind: "idle" });
  };

  const remove = async (): Promise<void> => {
    const done = await actions.run(
      "remove",
      () => libraries.remove({ libraryId }),
      "Library removed",
    );

    if (done !== undefined) await navigate({ to: "/admin/libraries" });
  };

  return (
    <LibraryView
      state={state}
      mode={mode}
      running={actions.running}
      sharing={<Sharing libraryId={libraryId} />}
      back={
        <Link
          key="libraries"
          to="/admin/libraries"
          className="font-sans text-label/label text-text-muted hover:text-text"
        >
          Libraries
        </Link>
      }
      onMode={setMode}
      onScan={() => void actions.run("scan", () => libraries.scan({ libraryId }), "Scan queued")}
      onRename={(name) => void rename(name)}
      onFolders={(text) => void changeFolders(text)}
      onRemove={() => void remove()}
    />
  );
}

type Scan = NonNullable<LibraryDetail["scan"]>;

/** The line under a library's title for each scan status. */
const SCAN_LINES: Readonly<Record<Scan["status"], (scan: Scan) => string>> = {
  queued: () => "Scan queued",
  running: ({ done, total }) =>
    done === null ? "Scanning" : `Scanning ${done}${total === null ? "" : ` of ${total}`} files`,
  succeeded: ({ finishedAt }) =>
    finishedAt === null ? "Scanned" : `Scanned ${formatTime(finishedAt)}`,
  failed: ({ error }) =>
    error === null ? "The last scan failed" : `The last scan failed: ${error}`,
  canceled: () => "The last scan was canceled",
};

const scanLine = (scan: Scan | null): string =>
  scan === null ? "Never scanned" : SCAN_LINES[scan.status](scan);

/** The library page for each {@link LibraryState}. */
export function LibraryView({
  state,
  mode,
  running,
  sharing,
  back,
  onMode,
  onScan,
  onRename,
  onFolders,
  onRemove,
}: {
  readonly state: LibraryState;
  readonly mode: LibraryMode;
  readonly running: LibraryAction | null;
  readonly sharing: ReactNode;
  /** The breadcrumb back to the libraries list. */
  readonly back: ReactNode;
  readonly onMode: (mode: LibraryMode) => void;
  readonly onScan: () => void;
  readonly onRename: (name: string) => void;
  readonly onFolders: (text: string) => void;
  readonly onRemove: () => void;
}) {
  return Match.value(state).pipe(
    Match.discriminatorsExhaustive("kind")({
      loading: () => <PageHeader title="Library" crumbs={[back]} />,
      missing: () => (
        <>
          <PageHeader title="Library" crumbs={[back]} />
          <Muted>This library doesn't exist, or it isn't shared with you.</Muted>
        </>
      ),
      failed: ({ message, retry }) => (
        <>
          <PageHeader title="Library" crumbs={[back]} />
          <Failed message={message} retry={retry} />
        </>
      ),
      ready: ({ library }) => (
        <ReadyLibrary
          library={library}
          mode={mode}
          running={running}
          sharing={sharing}
          back={back}
          onMode={onMode}
          onScan={onScan}
          onRename={onRename}
          onFolders={onFolders}
          onRemove={onRemove}
        />
      ),
    }),
  );
}

function ReadyLibrary({
  library,
  mode,
  running,
  sharing,
  back,
  onMode,
  onScan,
  onRename,
  onFolders,
  onRemove,
}: {
  readonly library: LibraryDetail;
  readonly mode: LibraryMode;
  readonly running: LibraryAction | null;
  readonly sharing: ReactNode;
  /** The breadcrumb back to the libraries list. */
  readonly back: ReactNode;
  readonly onMode: (mode: LibraryMode) => void;
  readonly onScan: () => void;
  readonly onRename: (name: string) => void;
  readonly onFolders: (text: string) => void;
  readonly onRemove: () => void;
}) {
  const busy = running !== null;
  const manages = library.level === "manage";
  const scanning = library.scan?.status === "queued" || library.scan?.status === "running";

  const facts = [
    KIND_LABELS[library.kind],
    library.items === null ? null : `${library.items} ${library.items === 1 ? "item" : "items"}`,
    LEVEL_LABELS[library.level],
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <>
      <PageHeader
        title={library.name}
        crumbs={[back]}
        facts={facts}
        actions={
          library.level === "view" ? null : (
            <Button variant="raised" size="xs" disabled={busy || scanning} onClick={onScan}>
              Scan now
            </Button>
          )
        }
      />
      <Muted>{scanLine(library.scan)}</Muted>
      {manages ? (
        <Section title="Name">
          {mode.kind === "renaming" ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();

                if (mode.name.trim() !== "") onRename(mode.name);
              }}
            >
              <TextField
                label="Name"
                value={mode.name}
                onChange={(event) => onMode({ kind: "renaming", name: event.target.value })}
                className="min-w-0 flex-1 basis-48"
              />
              <Button type="submit" size="md" disabled={busy || mode.name.trim() === ""}>
                Save
              </Button>
              <Button variant="ghost" size="md" onClick={() => onMode({ kind: "idle" })}>
                Cancel
              </Button>
            </form>
          ) : (
            <div>
              <Button
                variant="raised"
                size="xs"
                disabled={busy}
                onClick={() => onMode({ kind: "renaming", name: library.name })}
              >
                Rename
              </Button>
            </div>
          )}
        </Section>
      ) : null}
      {library.folders === null ? null : (
        <Section title="Folders">
          {mode.kind === "folders" ? (
            <form
              className="flex flex-col gap-3 md:max-w-120"
              onSubmit={(event) => {
                event.preventDefault();

                if (foldersOf(mode.text).length > 0) onFolders(mode.text);
              }}
            >
              <FoldersField
                value={mode.text}
                onChange={(text) => onMode({ kind: "folders", text })}
              />
              <Muted>What a removed folder held leaves the library.</Muted>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="xs"
                  disabled={busy || foldersOf(mode.text).length === 0}
                >
                  Save folders
                </Button>
                <Button variant="ghost" size="xs" onClick={() => onMode({ kind: "idle" })}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <>
              <ul aria-label="Folders" className="flex flex-col gap-1">
                {library.folders.map((folder) => (
                  <li key={folder} className="truncate font-mono text-label/label text-text">
                    {folder}
                  </li>
                ))}
              </ul>
              <div>
                <Button
                  variant="raised"
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    onMode({ kind: "folders", text: library.folders?.join("\n") ?? "" })
                  }
                >
                  Change folders
                </Button>
              </div>
            </>
          )}
        </Section>
      )}
      {manages ? sharing : null}
      {manages ? (
        <Section title="Remove">
          {mode.kind === "removing" ? (
            <Notice
              action={
                <div className="flex gap-2">
                  <Button variant="ghost" size="xs" onClick={() => onMode({ kind: "idle" })}>
                    Cancel
                  </Button>
                  <Button variant="destructive" size="xs" disabled={busy} onClick={onRemove}>
                    Remove
                  </Button>
                </div>
              }
            >
              {`${library.name} and everything it lists are deleted. The files on disk stay.`}
            </Notice>
          ) : (
            <div>
              <Button
                variant="destructive"
                size="xs"
                disabled={busy}
                onClick={() => onMode({ kind: "removing" })}
              >
                Remove library
              </Button>
            </div>
          )}
        </Section>
      ) : null}
    </>
  );
}

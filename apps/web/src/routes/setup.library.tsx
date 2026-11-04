import type { LibraryKind } from "@media/contracts/models/catalog";
import { useCommand } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { cn } from "@media/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  FilmIcon,
  FolderIcon,
  LockIcon,
  PlusIcon,
  TvIcon,
  XIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import { AuthPage, PageTitle, SetupSteps } from "@/components/auth/auth-page";
import { describeFailure } from "@/lib/failure";
import { folderProblem, normalizeFolder } from "@/lib/library-folders";
import { RequireSignedIn } from "@/session/guards";
import { BlankPage, Redirect } from "@/session/redirect";
import { useViewer } from "@/session/viewer";

export const Route = createFileRoute("/setup/library")({
  head: () => ({ meta: [{ title: "Add a library · [movies]" }] }),
  component: () => (
    <RequireSignedIn>
      <AddLibraryPage />
    </RequireSignedIn>
  ),
});

const KINDS: ReadonlyArray<{
  readonly kind: Extract<LibraryKind, "movies" | "shows">;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { kind: "movies", label: "Movies", icon: FilmIcon },
  { kind: "shows", label: "Shows", icon: TvIcon },
];

type FolderRow = { readonly key: number; readonly path: string; readonly problem: string | null };

function AddLibraryPage() {
  const viewer = useViewer();

  if (viewer === null) return <BlankPage />;

  if (!viewer.scopes.includes("manage")) return <Redirect href="/" />;

  return <AddLibraryForm />;
}

function AddLibraryForm() {
  const createLibrary = useCommand("libraries.create");
  const navigate = useNavigate();
  const [kind, setKind] = useState<"movies" | "shows">("movies");
  const [rows, setRows] = useState<ReadonlyArray<FolderRow>>([{ key: 0, path: "", problem: null }]);
  const [pending, setPending] = useState(false);
  const blocked = rows.some((row) => row.problem !== null);

  const setPath = (key: number, path: string): void =>
    setRows((current) =>
      current.map((row): FolderRow => (row.key === key ? { key, path, problem: null } : row)),
    );

  const submit = async (event?: FormEvent<HTMLFormElement>): Promise<void> => {
    event?.preventDefault();

    const checked = rows.map((row): FolderRow => ({
      key: row.key,
      path: row.path,
      problem: folderProblem(row.path),
    }));

    setRows(checked);

    if (checked.some((row) => row.problem !== null)) return;

    setPending(true);

    try {
      const roots = checked.map((row) => normalizeFolder(row.path));

      const created = await createLibrary({
        name: kind === "movies" ? "Movies" : "Shows",
        kind,
        roots,
      });

      await navigate({
        to: "/setup/scan",
        search: { jobId: created.jobId, libraryId: created.libraryId },
      });
    } catch (cause) {
      const message = describeFailure(cause);
      const named = checked.find((row) => message.includes(normalizeFolder(row.path)));
      const target = named ?? checked[0];

      setRows(
        checked.map((row): FolderRow =>
          row.key === target?.key ? { key: row.key, path: row.path, problem: message } : row,
        ),
      );
      setPending(false);
    }
  };

  return (
    <AuthPage width="wide">
      <div className="flex flex-col gap-3">
        <SetupSteps step={2} label="Library" />
        <PageTitle>Point us at your films.</PageTitle>
      </div>
      <form className="flex flex-col gap-8" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span id="library-kind" className="text-label/caption font-medium text-text-muted">
              This folder contains
            </span>
            <div
              role="radiogroup"
              aria-labelledby="library-kind"
              className="flex gap-1 rounded-control border border-hairline bg-surface-raised p-1"
            >
              {KINDS.map((option) => {
                const selected = option.kind === kind;

                return (
                  <button
                    key={option.kind}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setKind(option.kind)}
                    className={cn(
                      "flex h-9 grow basis-0 cursor-pointer items-center justify-center gap-2 rounded-inner text-label/caption transition-colors",
                      selected
                        ? "bg-text font-semibold text-bg"
                        : "font-medium text-text-muted hover:text-text",
                    )}
                  >
                    <option.icon className="size-4" strokeWidth={1.75} aria-hidden />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-label/caption font-medium text-text-muted">Folder path</span>
            <div className="flex flex-col gap-2">
              {rows.map((row, index) => (
                <FolderField
                  key={row.key}
                  row={row}
                  label={index === 0 ? "Folder path" : `Folder path ${index + 1}`}
                  onChange={(path) => setPath(row.key, path)}
                  onRetry={() => void submit()}
                  onRemove={
                    rows.length === 1
                      ? undefined
                      : () => setRows((current) => current.filter((other) => other.key !== row.key))
                  }
                />
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              setRows((current) => [
                ...current,
                { key: Math.max(...current.map((row) => row.key)) + 1, path: "", problem: null },
              ])
            }
            className="flex h-11 cursor-pointer items-center gap-2.5 self-start rounded-control text-label/caption font-semibold text-text"
          >
            <PlusIcon className="size-4" strokeWidth={1.75} aria-hidden />
            Add another folder
          </button>
        </div>
        <Button
          type="submit"
          size="lg"
          className={cn(
            "w-full",
            blocked && "bg-surface-raised text-text-muted hover:bg-surface-raised",
          )}
          disabled={pending || blocked}
        >
          Save and start scan
          <ArrowRightIcon strokeWidth={2} aria-hidden />
        </Button>
      </form>
    </AuthPage>
  );
}

function FolderField({
  row,
  label,
  onChange,
  onRetry,
  onRemove,
}: {
  readonly row: FolderRow;
  readonly label: string;
  readonly onChange: (path: string) => void;
  readonly onRetry: () => void;
  readonly onRemove: (() => void) | undefined;
}) {
  const problemId = `folder-${row.key}-problem`;

  return (
    <div className="flex flex-col rounded-control bg-surface-raised">
      <div className="flex h-11 items-center gap-2.5 pr-1.5 pl-3.5">
        <FolderIcon className="size-4 shrink-0 text-text" strokeWidth={1.75} aria-hidden />
        <input
          aria-label={label}
          aria-invalid={row.problem !== null || undefined}
          aria-describedby={row.problem === null ? undefined : problemId}
          placeholder="/mnt/nas/movies"
          spellCheck={false}
          autoComplete="off"
          value={row.path}
          onChange={(event) => onChange(event.target.value)}
          className="h-full min-w-0 grow bg-transparent font-mono text-small/label text-text caret-accent outline-none placeholder:text-text-muted"
        />
        {row.problem === null ? (
          onRemove === undefined ? null : (
            <button
              type="button"
              aria-label={`Remove ${label.toLowerCase()}`}
              onClick={onRemove}
              className="flex size-8 cursor-pointer items-center justify-center rounded-inner text-text-muted hover:text-text"
            >
              <XIcon className="size-4" strokeWidth={1.75} aria-hidden />
            </button>
          )
        ) : (
          <button
            type="button"
            onClick={onRetry}
            className="flex h-8 cursor-pointer items-center rounded-inner bg-text/8 px-3 text-label/caption font-semibold text-text hover:bg-text/12"
          >
            Try again
          </button>
        )}
      </div>
      {row.problem === null ? null : (
        <div id={problemId} className="flex items-start gap-2.5 px-3.5 pt-1 pb-4">
          <LockIcon className="size-4 shrink-0 text-accent" strokeWidth={1.75} aria-hidden />
          <div className="flex grow basis-0 flex-col gap-1">
            <p className="text-label/label font-semibold text-text">Can't use this folder</p>
            <p className="text-label/label text-text-muted">{row.problem}</p>
          </div>
        </div>
      )}
    </div>
  );
}

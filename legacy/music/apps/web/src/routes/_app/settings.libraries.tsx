import type { Job, Library } from "@music/commands/models";
import { useRead, useRun } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { Chip } from "@music/ui/components/chip";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@music/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@music/ui/components/dropdown-menu";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { Skeleton } from "@music/ui/components/skeleton";
import { cn } from "@music/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { FolderIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { ProgressBar, jobPercent } from "@/components/auth/scan-progress";
import { AdminOnly, SettingsHeader, TerminalHint } from "@/components/settings/settings-ui";
import { describeFailure, useAction } from "@/lib/action";
import { formatAgo, formatCount } from "@/lib/format";

const LibrariesSearch = Schema.Struct({ add: Schema.optionalKey(Schema.String) });

export const Route = createFileRoute("/_app/settings/libraries")({
  validateSearch: Schema.toStandardSchemaV1(LibrariesSearch),
  component: LibrariesSettings,
});

function LibrariesSettings() {
  const me = useRead("account.me", {});

  if (me === undefined) return <Skeleton className="h-40 w-full rounded-lg" />;

  if (me.role !== "admin") return <AdminOnly />;

  return <Libraries />;
}

function Libraries() {
  const libraries = useRead("libraries.list", {});
  const jobs = useRead("jobs.list", {});
  const { add } = Route.useSearch();
  const navigate = useNavigate();
  const adding = add !== undefined;

  const setAdding = (open: boolean) =>
    void navigate({ to: "/settings/libraries", search: open ? { add: "1" } : {}, replace: true });

  return (
    <div className="flex flex-col gap-6">
      <SettingsHeader
        title="Libraries"
        lead="Folders [music] reads from. Files are never changed unless you or an agent run a file command."
        action={
          <Button variant="solid" className="pr-[18px] pl-3.5" onClick={() => setAdding(true)}>
            <PlusIcon strokeWidth={2} />
            Add folder
          </Button>
        }
      />
      {libraries === undefined ? (
        <Skeleton className="h-32 w-full rounded-lg" />
      ) : libraries.length === 0 ? (
        <div className="flex flex-col items-start gap-2.5 rounded-lg border border-dashed border-border p-8">
          <span className="font-sans text-md/base font-semibold text-text">
            No library folders yet
          </span>
          <span className="max-w-[520px] font-sans text-base/base text-text-muted">
            Add the folder where your music lives, such as a NAS mount. The first scan starts right
            away.
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {libraries.map((library) => (
            <LibraryCard
              key={library.id}
              library={library}
              // Jobs come newest first, so this is the folder's latest scan.
              latest={(jobs ?? []).find((job) => job.libraryId === library.id)}
            />
          ))}
        </div>
      )}
      <TerminalHint
        label="From a terminal"
        command="music libraries list · music libraries scan --help"
      />
      <AddLibraryDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

const DOT_COLOR = { accent: "bg-accent", success: "bg-success", danger: "bg-danger" } as const;

function Stat({
  value,
  label,
  dot,
}: {
  readonly value: ReactNode;
  readonly label: string;
  readonly dot?: keyof typeof DOT_COLOR;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 font-mono text-md/base text-text">
        {dot === undefined ? null : (
          <span aria-hidden className={cn("size-1.5 rounded-full", DOT_COLOR[dot])} />
        )}
        {value}
      </span>
      <span className="font-sans text-sm/xs text-text-muted">{label}</span>
    </div>
  );
}

function LibraryCard({
  library,
  latest,
}: {
  readonly library: Library;
  /** The folder's most recent scan job, if any. */
  readonly latest: Job | undefined;
}) {
  const job = latest?.status === "running" || latest?.status === "pending" ? latest : undefined;
  const failed = latest?.status === "failed" ? latest : undefined;
  const scan = useRun("libraries.scan");
  const remove = useRun("libraries.delete");
  const [confirming, setConfirming] = useState(false);
  const busy = job !== undefined || library.scanning;

  const [rescan, rescanning] = useAction(() => scan({ libraryId: library.id }), {
    success: () => `Rescanning ${library.path}`,
  });

  const [removeLibrary, removing] = useAction(
    async () => {
      await remove({ libraryId: library.id });
      setConfirming(false);
    },
    { success: () => `Removed ${library.path} from the index` },
  );

  const percent = job === undefined ? null : jobPercent(job);

  return (
    <section
      aria-label={library.path}
      className="flex flex-col gap-3.5 rounded-lg border border-border p-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <FolderIcon aria-hidden className="size-5 text-text" />
        <span className="min-w-0 grow truncate font-mono text-md/base text-text">
          {library.path}
        </span>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 font-sans text-sm/xs font-medium text-text",
            library.visibility === "shared" ? "bg-surface" : "border border-border",
          )}
        >
          {library.visibility === "shared" ? "Everyone" : "Only you"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="px-2 text-text"
          disabled={busy}
          pending={rescanning}
          onClick={() => void rescan()}
        >
          {busy ? "Scanning…" : "Rescan"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`More actions for ${library.path}`}
            className="flex size-8 items-center justify-center rounded-full text-text-muted hover:bg-surface hover:text-text"
          >
            <MoreHorizontalIcon className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem tone="danger" onClick={() => setConfirming(true)}>
              Remove from [music]…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap gap-x-row gap-y-3 pl-8">
        <Stat value={formatCount(library.trackCount)} label="songs" />
        <Stat
          value={library.lastScanAt === null ? "Never" : formatAgo(library.lastScanAt)}
          label="last full scan"
        />
        {busy ? (
          <Stat
            value={
              job === undefined || job.total === null
                ? "Scanning"
                : `${formatCount(job.done)} / ${formatCount(job.total)}`
            }
            label={job?.status === "pending" ? "waiting for the scanner" : "scanning now"}
            dot="accent"
          />
        ) : failed === undefined ? (
          <Stat value="Ready" label="up to date with the last scan" dot="success" />
        ) : (
          <Stat
            value="Scan failed"
            label={failed.error ?? "The last scan didn't finish"}
            dot="danger"
          />
        )}
      </div>
      {percent === null ? null : (
        <ProgressBar
          percent={percent}
          className="ml-8 h-[3px]"
          label={`Scanning ${library.path}`}
        />
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          title={`Remove ${library.path}?`}
          description="Its songs leave the library, playlists, and likes. The files on disk stay untouched."
        >
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button variant="danger" pending={removing} onClick={() => void removeLibrary()}>
              Remove folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function AddLibraryDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const create = useRun("libraries.create");
  const [path, setPath] = useState("");
  const [visibility, setVisibility] = useState<"shared" | "private">("shared");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = path.trim();

    if (!trimmed.startsWith("/")) {
      setError("Use an absolute path that the server can read, such as /music.");

      return;
    }

    setPending(true);
    setError(null);

    try {
      const name = trimmed.split("/").findLast((part) => part.length > 0) ?? "Music";
      await create({ name, path: trimmed, visibility });
      setPath("");
      onOpenChange(false);
    } catch (cause) {
      setError(describeFailure(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add a library folder"
        description="The first scan starts right away and runs in the background."
      >
        <form className="flex flex-col gap-6" onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="library-path">Library folder</FieldLabel>
            <Input
              id="library-path"
              className="font-mono text-base/sm"
              spellCheck={false}
              autoComplete="off"
              placeholder="/music"
              aria-invalid={error !== null}
              aria-describedby="library-path-hint"
              value={path}
              onChange={(event) => {
                setPath(event.target.value);
                setError(null);
              }}
              start={<FolderIcon aria-hidden />}
            />
            <FieldHint id="library-path-hint" tone={error === null ? "muted" : "danger"}>
              {error ?? "The path inside the server or container."}
            </FieldHint>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="font-sans text-sm/xs font-medium text-text">Who can see it</span>
            <div role="group" aria-label="Who can see it" className="flex gap-2">
              <Chip selected={visibility === "shared"} onClick={() => setVisibility("shared")}>
                Everyone on this server
              </Chip>
              <Chip selected={visibility === "private"} onClick={() => setVisibility("private")}>
                Only me
              </Chip>
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
            <Button
              type="submit"
              variant="solid"
              disabled={path.trim().length === 0}
              pending={pending}
            >
              Add and scan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

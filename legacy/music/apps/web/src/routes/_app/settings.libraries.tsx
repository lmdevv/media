import type { UserId } from "@music/commands/ids";
import type { AccessControl, Job, Library, LibraryVisibility, User } from "@music/commands/models";
import { can, canRemoveLibrary, roleLabel, widensVisibility } from "@music/commands/permissions";
import { useRead, useRun } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { Chip } from "@music/ui/components/chip";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@music/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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

  if (!can(me.role, "admin")) return <AdminOnly />;

  return <Libraries me={me} />;
}

function Libraries({ me }: { readonly me: User }) {
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
          <Button variant="solid" className="pr-4.5 pl-3.5" onClick={() => setAdding(true)}>
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
          <span className="max-w-130 font-sans text-base/base text-text-muted">
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
              me={me}
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
      <AddLibraryDialog
        open={adding}
        onOpenChange={setAdding}
        serverOwner={can(me.role, "owner")}
      />
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
  me,
  latest,
}: {
  readonly library: Library;
  readonly me: User;
  /** The folder's most recent scan job, if any. */
  readonly latest: Job | undefined;
}) {
  const job = latest?.status === "running" || latest?.status === "pending" ? latest : undefined;
  const failed = latest?.status === "failed" ? latest : undefined;
  const scan = useRun("libraries.scan");
  const remove = useRun("libraries.delete");
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState<"name" | "access" | null>(null);
  const busy = job !== undefined || library.scanning;
  const myId = me.id;
  const owner = library.ownerId === myId ? "you" : (library.ownerName ?? "its owner");
  // Removing a library frees its folder, so only its owner or the server's owner may.
  const removable = canRemoveLibrary(me, library);

  const [rescan, rescanning] = useAction(() => scan({ libraryId: library.id }), {
    success: () => `Rescanning ${label}`,
  });

  const [removeLibrary, removing] = useAction(
    async () => {
      await remove({ libraryId: library.id });
      setConfirming(false);
    },
    { success: () => `Removed ${label} from the index` },
  );

  const percent = job === undefined ? null : jobPercent(job);
  // Only a library's managers see its folder; everyone else knows it by name.
  const label = library.path ?? library.name;

  return (
    <section
      aria-label={label}
      className="flex flex-col gap-3.5 rounded-lg border border-border p-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <FolderIcon aria-hidden className="size-5 text-text" />
        <span className="flex min-w-0 grow basis-40 flex-col gap-px">
          <span
            className={cn(
              "truncate text-md/base text-text",
              library.path === null ? "font-sans font-semibold" : "font-mono",
            )}
          >
            {label}
          </span>
          <span className="truncate font-sans text-sm/xs text-text-muted">
            {library.path === null ? "" : library.name}
            {library.ownerId === myId
              ? ""
              : `${library.path === null ? "" : " · "}added by ${owner}`}
          </span>
        </span>
        <button
          type="button"
          aria-label={`Who can listen to ${label}: ${visibilityLabel(library.visibility, owner)}`}
          onClick={() => setEditing("access")}
          className={cn(
            "cursor-pointer rounded-full px-2.5 py-1 font-sans text-sm/xs font-medium text-text outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            library.visibility === "shared" ? "bg-surface" : "border border-border",
          )}
        >
          {visibilityLabel(library.visibility, owner)}
        </button>
        {library.manageable ? (
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
        ) : null}
        {library.manageable ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`More actions for ${label}`}
              className="flex size-8 items-center justify-center rounded-full text-text-muted hover:bg-surface hover:text-text"
            >
              <MoreHorizontalIcon className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setEditing("name")}>Rename…</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEditing("access")}>
                Who can listen…
              </DropdownMenuItem>
              {removable ? <DropdownMenuSeparator /> : null}
              {removable ? (
                <DropdownMenuItem tone="danger" onClick={() => setConfirming(true)}>
                  Remove from [music]…
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-row gap-y-3 pl-8">
        <Stat value={formatCount(library.trackCount)} label="songs" />
        {library.readable ? null : (
          <Stat
            value="Not for you"
            label={
              library.manageable
                ? "you manage it; only its owner can let you listen"
                : "only the server's owner manages a library you can't hear"
            }
          />
        )}
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
        <ProgressBar percent={percent} className="ml-8 h-0.75" label={`Scanning ${label}`} />
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          title={`Remove ${label}?`}
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
      <Dialog open={editing !== null} onOpenChange={(open) => setEditing(open ? editing : null)}>
        {editing === "name" ? (
          <RenameForm library={library} onDone={() => setEditing(null)} />
        ) : null}
        {editing === "access" ? (
          <AccessForm
            library={library}
            owner={owner}
            control={library.accessControl}
            serverOwner={can(me.role, "owner")}
            removable={removable}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Dialog>
    </section>
  );
}

/** The visibility pill: who besides the owner can listen. */
const visibilityLabel = (visibility: LibraryVisibility, owner: string): string =>
  ({
    shared: "Everyone",
    restricted: "Specific people",
    private: owner === "you" ? "Only you" : `Only ${owner}`,
  })[visibility];

function RenameForm({
  library,
  onDone,
}: {
  readonly library: Library;
  readonly onDone: () => void;
}) {
  const update = useRun("libraries.update");
  // Untouched, the field shows the current name, including a rename made elsewhere meanwhile.
  const [edited, setName] = useState<string | null>(null);
  const name = edited ?? library.name;
  const trimmed = name.trim();

  const [save, saving] = useAction(
    async () => {
      await update({ libraryId: library.id, name: trimmed });
      onDone();
    },
    { success: () => `Renamed to ${trimmed}` },
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (trimmed.length > 0 && trimmed !== library.name) void save();
  };

  return (
    <DialogContent
      title="Rename library folder"
      description={`The name people see for ${library.path ?? library.name}. The folder on disk keeps its name.`}
    >
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="library-name">Name</FieldLabel>
          <Input
            id="library-name"
            autoComplete="off"
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
          <Button
            type="submit"
            variant="solid"
            disabled={trimmed.length === 0 || trimmed === library.name}
            pending={saving}
          >
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * Who hears a private library, said to its owner. It is hidden from other members and admins,
 * not from the server's owner, who runs the machine: they may rename or rescan it, and could
 * remove it and add the folder again as their own, which its owner would see.
 */
const privateHint = (serverOwner: boolean): string =>
  serverOwner
    ? "Only you."
    : "Only you, hidden from other members and admins. Not from the server's owner, who runs " +
      "the machine: they can rename or rescan it, and removing it is something you'd see.";

const VISIBILITY_HINTS: Readonly<
  Record<LibraryVisibility, (owner: string, serverOwner: boolean) => string>
> = {
  shared: () => "Everyone on the server except guests, and the guests added below.",
  restricted: (owner) => `Only the people below, and ${owner}.`,
  private: (owner, serverOwner) => (owner === "you" ? privateHint(serverOwner) : `Only ${owner}.`),
};

/**
 * Why the viewer can change who listens only partly, or not at all, and what they may still do.
 * Only the library's owner, while an admin, lets people in; once they aren't one, the server's
 * owner may only take people out or make it more private.
 */
const accessNote = (
  control: Exclude<AccessControl, "full">,
  owner: string,
  library: Library,
  removable: boolean,
): string =>
  control === "narrow"
    ? `${owner} doesn't run libraries now, so you can only let fewer people listen: remove ` +
      "people, or make it more private. Only they, as an admin again, can let anyone in."
    : `Only ${owner} can change who listens to this folder. ${stillCan(library, removable)}`;

/** What a viewer who doesn't own a library may still do with it, for the access dialog. */
const stillCan = (library: Library, removable: boolean): string => {
  if (removable) return "You can still rename, rescan, or remove it.";

  return library.manageable
    ? "You can still rename or rescan it."
    : "Only the server's owner manages a library you can't hear.";
};

/** Who can listen to a library: its visibility and the people added to it. */
function AccessForm({
  library,
  owner,
  control,
  serverOwner,
  removable,
  onDone,
}: {
  readonly library: Library;
  /** How to name the owner: "you", or their name. */
  readonly owner: string;
  /**
   * How the viewer may change who listens (`libraryAccessControl`): the library's owner, while an
   * admin, any way; the server's owner, once its owner isn't one, only to let fewer people in.
   */
  readonly control: AccessControl;
  /** Whether the viewer owns the server, and so manages every library. */
  readonly serverOwner: boolean;
  /** Whether the viewer may remove the library (`canRemoveLibrary`). */
  readonly removable: boolean;
  readonly onDone: () => void;
}) {
  const update = useRun("libraries.update");
  const grant = useRun("libraries.grant");
  const revoke = useRun("libraries.revoke");
  // Only a library's managers may read its access list (anyone else gets not_found, which would
  // take the whole screen down), and only who may change access adds people.
  const people = useRead("people.list", control === "full" ? {} : "skip");

  const added = useRead(
    "libraries.people",
    library.manageable ? { libraryId: library.id } : "skip",
  );

  const visibility = library.visibility;

  const [setVisibility, changing] = useAction(
    (next: LibraryVisibility) => update({ libraryId: library.id, visibility: next }),
    { success: () => "Saved who can listen" },
  );

  const [add, adding] = useAction((userId: UserId) => grant({ libraryId: library.id, userId }));
  const [remove] = useAction((userId: UserId) => revoke({ libraryId: library.id, userId }));
  const addedIds = new Set((added ?? []).map((person) => person.id));

  // Shared folders already reach everyone but guests, so only guests are worth adding.
  const candidates = (people ?? []).filter(
    (person) =>
      person.id !== library.ownerId &&
      !addedIds.has(person.id) &&
      (visibility === "restricted" || person.role === "guest"),
  );

  return (
    <DialogContent title="Who can listen" description={library.path ?? library.name}>
      <div className="flex flex-col gap-1.5">
        <div role="group" aria-label="Who can listen" className="flex flex-wrap gap-2">
          {(["shared", "restricted", "private"] as const).map((option) => (
            <Chip
              key={option}
              selected={visibility === option}
              disabled={
                changing ||
                control === "none" ||
                (control === "narrow" && widensVisibility(visibility, option))
              }
              onClick={() => (option === visibility ? undefined : void setVisibility(option))}
            >
              {visibilityLabel(option, owner)}
            </Chip>
          ))}
        </div>
        <FieldHint>{VISIBILITY_HINTS[visibility](owner, serverOwner)}</FieldHint>
        {control === "full" ? null : (
          <FieldHint>{accessNote(control, owner, library, removable)}</FieldHint>
        )}
      </div>
      {visibility === "private" || !library.manageable ? null : (
        <div className="flex flex-col gap-2">
          <span className="font-sans text-sm/xs font-medium text-text">
            {visibility === "shared" ? "Guests who can listen" : "People who can listen"}
          </span>
          {added === undefined ? (
            <Skeleton className="h-12 w-full rounded-md" />
          ) : (
            <ul aria-label="People who can listen" className="flex flex-col">
              {added.length === 0 ? (
                <li className="py-2 font-sans text-sm/xs text-text-muted">Nobody added yet.</li>
              ) : null}
              {added.map((person) => (
                <li
                  key={person.id}
                  className="flex min-h-11 items-center gap-3 border-b border-border py-1.5"
                >
                  <span className="flex min-w-0 grow flex-col">
                    <span className="truncate font-sans text-base/sm text-text">
                      {person.name ?? person.email}
                    </span>
                    <span className="truncate font-sans text-sm/xs text-text-muted">
                      {roleLabel(person.role)} · {person.email}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={control === "none"}
                    aria-label={`Remove ${person.name ?? person.email}`}
                    onClick={() => void remove(person.id)}
                    className="font-sans text-sm/xs font-medium text-danger hover:underline disabled:cursor-not-allowed disabled:opacity-(--opacity-disabled) disabled:no-underline"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {candidates.length === 0 || control !== "full" ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="secondary" size="sm" className="w-fit" pending={adding} />}
              >
                <PlusIcon strokeWidth={2} />
                Add someone
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {candidates.map((person) => (
                  <DropdownMenuItem key={person.id} onClick={() => void add(person.id)}>
                    {person.name ?? person.email} · {roleLabel(person.role)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      <DialogFooter>
        <Button variant="solid" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

const ADD_VISIBILITY_HINTS: Readonly<Record<LibraryVisibility, (serverOwner: boolean) => string>> =
  {
    shared: () => "Everyone but guests. You can add guests from the folder's menu.",
    restricted: () => "Only the people you add from the folder's menu after it's created.",
    private: privateHint,
  };

function AddLibraryDialog({
  open,
  onOpenChange,
  serverOwner,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Whether the viewer owns the server, and so manages every library. */
  readonly serverOwner: boolean;
}) {
  const create = useRun("libraries.create");
  const [path, setPath] = useState("");
  const [visibility, setVisibility] = useState<LibraryVisibility>("shared");
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
            <div role="group" aria-label="Who can see it" className="flex flex-wrap gap-2">
              <Chip selected={visibility === "shared"} onClick={() => setVisibility("shared")}>
                Everyone on this server
              </Chip>
              <Chip
                selected={visibility === "restricted"}
                onClick={() => setVisibility("restricted")}
              >
                Specific people
              </Chip>
              <Chip selected={visibility === "private"} onClick={() => setVisibility("private")}>
                Only me
              </Chip>
            </div>
            <FieldHint>{ADD_VISIBILITY_HINTS[visibility](serverOwner)}</FieldHint>
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

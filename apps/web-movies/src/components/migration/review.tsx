import type {
  ImportConnection,
  ImportPlanArgs,
  ImportStarted,
  MigrationSourceFailure,
  PlannedLibraryAccess,
} from "@media/contracts/models/migration";
import { mappingsWith } from "@media/contracts/migration-plan";
import { usePlatform } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { Input } from "@media/ui/components/input";
import { PageHeader } from "@media/ui/components/page-header";
import { FieldError } from "@media/ui/components/text-field";
import { useAllPages } from "@media/ui/lib/pages";
import { ChevronDownIcon } from "lucide-react";
import { Option } from "effect";
import { useId, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { useAction } from "@/components/admin/action";
import { formatCount } from "@/components/admin/format";
import { useMediaServer } from "@/session/error-reporting";

import { usePreview } from "./connect";
import type { Preview } from "./connect";
import { mappingsFor, userRows } from "./migration-model";
import type { SourceForm, UserChoice, UserRow } from "./migration-model";

import { Caution, SectionLabel, Stat, Stats } from "./parts";

type Ready = Extract<Preview, { readonly status: "ready" }>;

function UserMappingRow({
  row,
  disabled,
  onChoose,
}: {
  readonly row: UserRow;
  readonly disabled: boolean;
  readonly onChoose: (choice: UserChoice) => void;
}) {
  const id = useId();

  return (
    <div className="flex items-center justify-between gap-6">
      <label htmlFor={id} className="truncate font-sans text-label/5 text-text">
        {row.name}
      </label>
      <div className="relative flex w-56 shrink-0 items-center">
        <select
          id={id}
          value={row.choice}
          disabled={disabled}
          onChange={(event) => {
            const next = row.options.find((option) => option.value === event.target.value);

            if (next !== undefined) onChoose(next.value);
          }}
          className="h-9 w-full cursor-pointer appearance-none rounded-control border border-hairline bg-surface pr-8 pl-3 font-sans text-label/label text-text outline-none disabled:cursor-not-allowed disabled:opacity-(--opacity-disabled)"
        >
          {row.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          className="pointer-events-none absolute right-3 size-3 text-text-muted"
          strokeWidth={1.75}
          aria-hidden
        />
      </div>
    </div>
  );
}

function UnmappedFolder({
  sourcePath,
  disabled,
  onMap,
}: {
  readonly sourcePath: string;
  readonly disabled: boolean;
  readonly onMap: (to: string) => Promise<boolean>;
}) {
  const id = useId();
  const [to, setTo] = useState("");
  const [invalid, setInvalid] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setInvalid(!(await onMap(to)));
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-1.5">
      <label htmlFor={id} className="truncate font-mono text-label/5 text-text-muted">
        {sourcePath}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={to}
          onChange={(event) => {
            setTo(event.target.value);
            setInvalid(false);
          }}
          placeholder="Folder on this server"
          aria-invalid={invalid || undefined}
          className="h-9 font-mono text-label/label"
        />
        <Button type="submit" variant="raised" size="sm" disabled={disabled || to.trim() === ""}>
          Map
        </Button>
      </div>
      {invalid ? <FieldError>Enter the folder’s full path, starting with /.</FieldError> : null}
    </form>
  );
}

const sharedWith = (access: PlannedLibraryAccess): string => {
  if (access.kind === "everyone") return "everyone";
  const people = access.sourceUserIds.length;

  if (people === 0) return "admins only";

  return people === 1 ? "admins and 1 person" : `admins and ${formatCount(people)} people`;
};

/**
 * 02 Review: the dry run's summary before anything is written. Each source user's history goes to
 * a user here or is skipped; folders the source has but this host doesn't can be mapped. Changing
 * either runs the dry run again.
 */
export function Review({
  form,
  preview,
  onPreview,
  onFailed,
  onBack,
  onStarted,
}: {
  readonly form: SourceForm;
  readonly preview: Ready;
  readonly onPreview: (preview: Ready) => void;
  readonly onFailed: (failure: MigrationSourceFailure) => void;
  readonly onBack: () => void;
  readonly onStarted: (started: ImportStarted) => void;
}) {
  const { connection, report } = preview;
  const platform = usePlatform();
  const media = useMediaServer();
  const reconnect = usePreview();

  const people = useAllPages(platform.core.accounts.users.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const rows = useMemo(
    () =>
      userRows(connection, report, people.status === "ready" ? people.rows : [], "Don’t import"),
    [connection, report, people],
  );

  const settle = (result: Preview | undefined): void => {
    if (result === undefined) return;

    if (result.status === "failed") onFailed(result);
    else onPreview(result);
  };

  const refresh = useAction(
    async (next: ImportPlanArgs): Promise<Preview> => {
      const result = await media.run("imports.preview", next);

      return result.status === "failed" ? result : { status: "ready", connection, report: result };
    },
    { quiet: true },
  );

  const remap = useAction(reconnect, { quiet: true });

  const begin = useAction(
    async (): Promise<void> => {
      const result = await media.run("imports.start", {
        connectionId: connection.connectionId,
        users: mappingsFor(rows),
      });

      if (result.status === "failed") onFailed(result);
      else onStarted(result);
    },
    { quiet: true },
  );

  const busy = refresh.pending || remap.pending || begin.pending;
  const problem = refresh.error ?? remap.error ?? begin.error;
  const { summary } = report;
  const importing = report.users.filter((user) => user.action === "import");
  const skipped = report.users.filter((user) => user.action !== "import");

  const choose = (sourceUserId: string, choice: UserChoice): void => {
    void refresh
      .run({
        connectionId: connection.connectionId,
        users: mappingsFor(rows, { sourceUserId, choice }),
      })
      .then(settle);
  };

  const map = async (from: string, to: string): Promise<boolean> => {
    const mappings = mappingsWith(connection.pathMappings, from, to);

    if (Option.isNone(mappings)) return false;

    settle(await remap.run(form, { users: mappingsFor(rows), pathMappings: mappings.value }));

    return true;
  };

  return (
    <>
      <PageHeader title="Ready to import" facts={facts(connection)} />
      <Stats>
        <Stat
          value={importing.length}
          label={importing.length === 1 ? "user" : "users"}
          detail={importing.map((user) => user.name).join(", ")}
        />
        <Stat value={summary.watched} label="watched" />
        <Stat value={summary.inProgress} label="in progress" />
        <Stat value={summary.favorites} label="favorites" />
      </Stats>
      {rows.length === 0 ? null : (
        <section
          aria-labelledby="migration-users"
          className="flex w-full max-w-dialog flex-col gap-3 pt-4"
        >
          <SectionLabel id="migration-users">Users · history goes to</SectionLabel>
          {rows.map((row) => (
            <UserMappingRow
              key={row.sourceUserId}
              row={row}
              disabled={busy}
              onChoose={(choice) => choose(row.sourceUserId, choice)}
            />
          ))}
        </section>
      )}
      <section
        aria-labelledby="migration-libraries"
        className="flex w-full max-w-dialog flex-col gap-3.5 pt-4"
      >
        <SectionLabel id="migration-libraries">Libraries · used in place</SectionLabel>
        {report.libraries.map((library) => (
          <div key={library.sourceLibraryId} className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-6">
              <span className="truncate font-mono text-label/5 text-text">
                {library.roots.length === 0 ? "—" : library.roots.join(", ")}
              </span>
              <span className="shrink-0 font-sans text-label/5 text-text-muted">
                {library.name} ·{" "}
                {library.existingLibraryId === null
                  ? `new, ${sharedWith(library.access)}`
                  : "already here"}
              </span>
            </div>
            {library.unmappedFolders.map((folder) => (
              <UnmappedFolder
                key={folder}
                sourcePath={folder}
                disabled={busy}
                onMap={(to) => map(folder, to)}
              />
            ))}
          </div>
        ))}
      </section>
      <div className="flex flex-col gap-2 pt-2">
        {summary.itemsUnmatched === 0 ? null : (
          <Caution>
            {summary.itemsUnmatched === 1
              ? "1 title couldn’t be matched and will be skipped"
              : `${formatCount(summary.itemsUnmatched)} titles couldn’t be matched and will be skipped`}
          </Caution>
        )}
        {skipped.length === 0 ? null : (
          <Caution>{skipped.map((user) => user.name).join(", ")} won’t be imported</Caution>
        )}
        {summary.conflicts === 0 ? null : (
          <Caution>
            {summary.conflicts === 1
              ? "1 title keeps the newer progress already in [movies]"
              : `${formatCount(summary.conflicts)} titles keep the newer progress already in [movies]`}
          </Caution>
        )}
      </div>
      {problem === undefined ? null : <FieldError>{problem}</FieldError>}
      <div className="flex items-center gap-2 pt-2">
        <Button size="md" disabled={busy} onClick={() => void begin.run()}>
          {begin.pending ? "Starting…" : "Import"}
        </Button>
        <Button variant="subtle" size="md" className="bg-transparent" onClick={onBack}>
          Back
        </Button>
      </div>
    </>
  );
}

const facts = (connection: ImportConnection): string =>
  `${connection.serverName} · ${connection.version}`;

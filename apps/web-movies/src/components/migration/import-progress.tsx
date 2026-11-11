import { SOURCE_NAMES } from "@media/contracts/migration-plan";
import { usePlatform } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { PageHeader } from "@media/ui/components/page-header";
import { ProgressBar } from "@media/ui/components/progress-bar";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { Link } from "@tanstack/react-router";

import { useAction } from "@/components/admin/action";
import { formatCount, formatPercent } from "@/components/admin/format";
import type { ImportRun } from "@/components/admin/types";
import { useNow } from "@media/ui/lib/use-now";

import { PHASE_LABELS, importFraction, importMinutesLeft } from "./migration-model";
import { Caution, Stat, Stats } from "./parts";

/** 03 Importing: the import's share done, time left, the phase it is in, and Cancel. */
export function Importing({ run }: { readonly run: ImportRun }) {
  const platform = usePlatform();
  const now = useNow(5_000);
  const fraction = importFraction(run);
  const stop = useAction(() => platform.movies.imports.cancel({ importId: run.importId }));
  const minutesLeft = importMinutesLeft(run, fraction, now);
  const { done, total } = run.job;
  const phase = PHASE_LABELS[run.phase];

  const detail =
    run.job.status === "queued"
      ? "Waiting for the media service"
      : total === null
        ? phase
        : `${phase} · ${formatCount(done)} of ${formatCount(total)}`;

  return (
    <>
      <PageHeader title={`Importing from ${SOURCE_NAMES[run.source]}`} />
      <p className="font-sans text-body/body text-text-muted">You can leave this page.</p>
      <div className="flex w-full max-w-dialog flex-col gap-4">
        <div className="flex items-baseline gap-4">
          <span className="font-sans text-display/display font-heavy tracking-display text-text">
            {formatPercent(fraction)}
          </span>
          {minutesLeft === null ? null : (
            <span className="font-sans text-body/body text-text-muted">
              about {minutesLeft} min left
            </span>
          )}
        </div>
        <ProgressBar
          value={fraction}
          tone="surface"
          label={`Import from ${SOURCE_NAMES[run.source]}`}
          className="rounded-bar"
        />
        <p className="font-sans text-label/label text-text-muted">{detail}</p>
      </div>
      <div>
        <Button variant="ghost" size="sm" disabled={stop.pending} onClick={() => void stop.run()}>
          {stop.pending ? "Cancelling…" : "Cancel import"}
        </Button>
      </div>
    </>
  );
}

/** 04 Done: what the import wrote, what it skipped, and the way home. */
export function Done({ run }: { readonly run: ImportRun }) {
  const { imported } = run;

  return (
    <>
      <PageHeader title={`Imported from ${SOURCE_NAMES[run.source]}`} />
      <Stats>
        <Stat value={imported.watched} label="watched" />
        <Stat value={imported.inProgress} label="in progress" />
        <Stat value={imported.favorites} label="favorites" />
        {imported.librariesAdded === 0 ? null : (
          <Stat
            value={imported.librariesAdded}
            label={imported.librariesAdded === 1 ? "library added" : "libraries added"}
          />
        )}
      </Stats>
      {imported.unmatched === 0 && imported.keptLocal === 0 ? null : (
        <div className="flex flex-col gap-2">
          {imported.unmatched === 0 ? null : (
            <Caution>
              {imported.unmatched === 1
                ? "1 title skipped"
                : `${formatCount(imported.unmatched)} titles skipped`}
            </Caution>
          )}
          {imported.keptLocal === 0 ? null : (
            <Caution>
              {formatCount(imported.keptLocal)} kept the newer progress already in [movies]
            </Caution>
          )}
        </div>
      )}
      <div>
        <Link to="/" className={buttonVariants({ size: "md" })}>
          Go to Home
        </Link>
      </div>
    </>
  );
}

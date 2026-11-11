import type { MigrationSourceFailure } from "@media/contracts/models/migration";
import { SOURCE_NAMES } from "@media/contracts/migration-plan";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { Spinner } from "@media/ui/components/spinner";
import { describeFailure } from "@media/ui/lib/failure";
import { useNavigate } from "@tanstack/react-router";
import { Match } from "effect";
import { useEffect, useState } from "react";

import { parseImportRunId } from "@/components/admin/route-params";
import type { ImportRunId } from "@/components/admin/route-params";
import type { ImportRun } from "@/components/admin/types";

import { Connect } from "./connect";
import type { Preview } from "./connect";
import { Done, Importing } from "./import-progress";
import { EMPTY_FORM, isRunning } from "./migration-model";
import type { SourceForm } from "./migration-model";
import { Review } from "./review";

/** How many of the newest imports the page looks through for one still running. */
const RECENT_RUNS = 10;

type Step =
  | { readonly kind: "connect"; readonly failure: MigrationSourceFailure | null }
  | { readonly kind: "review"; readonly preview: Extract<Preview, { readonly status: "ready" }> };

/**
 * Import from Jellyfin or Plex: connect, review one summary, import, done. Media files never
 * move; the server adds the same folders in place. A running import shows whenever the page opens
 * and is pinned to the URL, so the page lands on Done when it ends.
 *
 * @param importId - The import this page started or last showed, from the URL.
 */
export function MigrationScreen({ importId }: { readonly importId: ImportRunId | undefined }) {
  const platform = usePlatform();

  const runs = usePlatformQuery(platform.movies.imports.list, {
    paginationOpts: { numItems: RECENT_RUNS, cursor: null },
  });

  const pinned = usePlatformQuery(
    platform.movies.imports.get,
    ...(importId === undefined ? (["skip"] as const) : ([{ importId }] as const)),
  );

  const [form, setForm] = useState<SourceForm>(EMPTY_FORM);
  const [step, setStep] = useState<Step>({ kind: "connect", failure: null });
  const navigate = useNavigate();
  const active = runs.status === "success" ? runs.data.page.find(isRunning) : undefined;
  const activeId = active?.importId;

  useEffect(() => {
    if (activeId !== undefined && activeId !== importId) {
      void navigate({ to: "/admin/migration", search: { run: activeId }, replace: true });
    }
  }, [activeId, importId, navigate]);

  if (runs.status === "loading" || (importId !== undefined && pinned.status === "loading")) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="size-8 text-text" label="Loading" />
      </div>
    );
  }

  if (runs.status === "error") {
    return (
      <CalmState
        className="py-24"
        title="Couldn’t load imports"
        description={describeFailure(runs.error)}
        actions={
          <Button variant="raised" size="sm" onClick={runs.retry}>
            Try again
          </Button>
        }
      />
    );
  }

  const shown: ImportRun | undefined =
    active ?? (pinned.status === "success" ? pinned.data : undefined);

  if (shown !== undefined) {
    return Match.value(shown.job.status).pipe(
      Match.when("succeeded", () => <Done run={shown} />),
      Match.whenOr("failed", "canceled", () => (
        <CalmState
          className="py-24"
          title={`The import from ${SOURCE_NAMES[shown.source]} stopped`}
          description={shown.job.error ?? "It was cancelled before it finished."}
          actions={
            <Button onClick={() => void navigate({ to: "/admin/migration", search: {} })}>
              Start again
            </Button>
          }
        />
      )),
      Match.orElse(() => <Importing run={shown} />),
    );
  }

  return Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      connect: ({ failure }) => (
        <Connect
          form={form}
          failure={failure}
          onFormChange={setForm}
          onReady={(preview) => setStep({ kind: "review", preview })}
          onFailed={(next) => setStep({ kind: "connect", failure: next })}
        />
      ),
      review: ({ preview }) => (
        <Review
          form={form}
          preview={preview}
          onPreview={(next) => setStep({ kind: "review", preview: next })}
          onFailed={(next) => setStep({ kind: "connect", failure: next })}
          onBack={() => setStep({ kind: "connect", failure: null })}
          onStarted={(started) =>
            void navigate({
              to: "/admin/migration",
              search: { run: parseImportRunId(started.importId) },
            })
          }
        />
      ),
    }),
  );
}

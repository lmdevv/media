import type { JobId } from "@media/contracts/ids";
import type { MigrationSourceFailure } from "@media/contracts/models/migration";
import { useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { Spinner } from "@media/ui/components/spinner";
import { useNavigate } from "@tanstack/react-router";
import { SOURCE_NAMES } from "@media/contracts/migration-plan";
import { Match } from "effect";
import { useEffect, useState } from "react";

import { describeFailure } from "@/lib/failure";
import { isActive } from "@/lib/scan-progress";

import { Connect } from "./connect";
import type { Preview } from "./connect";
import type { SourceForm } from "./migration-model";
import { Done, Importing } from "./import-progress";
import { EMPTY_FORM } from "./migration-model";
import { Review } from "./review";

type Step =
  | { readonly kind: "connect"; readonly failure: MigrationSourceFailure | null }
  | { readonly kind: "review"; readonly preview: Extract<Preview, { readonly status: "ready" }> };

/**
 * Migration from Jellyfin or Plex: connect, review one summary, import, done. Media files never
 * move; [movies] adds the same folders in place. A running import shows whenever the page opens
 * and is pinned to the URL, so the page lands on Done when it ends.
 *
 * @param jobId - The import this page started or last showed, from the URL.
 */
export function MigrationScreen({ jobId }: { readonly jobId: JobId | undefined }) {
  const runs = useCommandQuery("migration.status", {});
  const [form, setForm] = useState<SourceForm>(EMPTY_FORM);
  const [step, setStep] = useState<Step>({ kind: "connect", failure: null });
  const navigate = useNavigate();
  const list = runs.status === "success" ? runs.data : [];
  const active = list.find((run) => isActive(run.job));
  const activeId = active?.job.id;

  useEffect(() => {
    if (activeId !== undefined && activeId !== jobId) {
      void navigate({ to: "/admin/migration", search: { job: activeId }, replace: true });
    }
  }, [activeId, jobId, navigate]);

  if (runs.status === "loading") {
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

  const shown =
    active ?? (jobId === undefined ? undefined : list.find((run) => run.job.id === jobId));

  if (shown !== undefined) {
    return Match.value(shown.job.status).pipe(
      Match.when("succeeded", () => <Done run={shown} />),
      Match.whenOr("failed", "cancelled", () => (
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
          onStarted={(job) => void navigate({ to: "/admin/migration", search: { job } })}
        />
      ),
    }),
  );
}

import { JobId } from "@media/contracts/ids";
import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { ScopeGate } from "@/components/admin/scope-gate";
import { MigrationScreen } from "@/components/migration/migration-screen";

const MigrationSearch = Schema.Struct({ job: Schema.optionalKey(JobId) });

export const Route = createFileRoute("/_app/admin/migration")({
  validateSearch: Schema.toStandardSchemaV1(MigrationSearch),
  head: () => ({ meta: [{ title: "Import from Jellyfin or Plex · [movies]" }] }),
  component: MigrationPage,
});

function MigrationPage() {
  const { job } = Route.useSearch();

  return (
    <ScopeGate scopes={["admin"]}>
      <MigrationScreen key={job ?? "new"} jobId={job} />
    </ScopeGate>
  );
}

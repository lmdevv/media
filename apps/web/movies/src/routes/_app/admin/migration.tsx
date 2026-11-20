import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { ImportRunId } from "@/components/admin/route-params";
import { ScopeGate } from "@/components/admin/scope-gate";
import {
  MigrationLoading,
  MigrationScreen,
  preloadMigration,
} from "@/components/migration/migration-screen";

const MigrationSearch = Schema.Struct({ run: Schema.optionalKey(ImportRunId) });

export const Route = createFileRoute("/_app/admin/migration")({
  validateSearch: Schema.toStandardSchemaV1(MigrationSearch),
  head: () => ({ meta: [{ title: "Import from Jellyfin or Plex · Lar Movies" }] }),
  loaderDeps: ({ search: { run } }) => ({ run }),
  loader: ({ context: { platform }, deps: { run } }) => preloadMigration(platform, run),
  pendingComponent: MigrationLoading,
  component: MigrationPage,
});

function MigrationPage() {
  const { run } = Route.useSearch();

  return (
    <ScopeGate access="admin">
      <MigrationScreen key={run ?? "new"} importId={run} />
    </ScopeGate>
  );
}

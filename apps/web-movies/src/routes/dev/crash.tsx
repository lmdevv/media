import { CalmState } from "@media/ui/components/calm-state";
import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { NotFoundPage } from "@/components/shell/route-states";

const CrashSearch = Schema.Struct({
  until: Schema.optionalKey(Schema.String),
});

/**
 * A screen that throws while rendering, to check the error screen and its Try again:
 * `/dev/crash?until=<ms>` renders normally from that time on. It exists only in development;
 * production builds answer it as an unknown address.
 */
export const Route = createFileRoute("/dev/crash")({
  validateSearch: Schema.toStandardSchemaV1(CrashSearch),
  component: import.meta.env.DEV ? CrashPage : NotFoundPage,
});

function CrashPage() {
  const { until } = Route.useSearch();

  if (until === undefined || !(Date.now() >= Number(until))) {
    throw new Error("This screen crashed on purpose");
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-page px-6">
      <CalmState title="This screen recovered" />
    </div>
  );
}

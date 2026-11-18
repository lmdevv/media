import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { Suspense, lazy } from "react";

const Bench = import.meta.env.DEV
  ? lazy(() =>
      import("@/dev/track-menu-bench").then((module) => ({ default: module.TrackMenuBench })),
    )
  : undefined;

const TracksSearch = Schema.Struct({
  columns: Schema.optionalKey(Schema.Literals(["1", "3", "4"])),
});

/**
 * The player's track menu over a still frame, with a long subtitle list, long translated labels,
 * and a full screen button: `/dev/tracks?columns=4`. Development builds only.
 */
export const Route = createFileRoute("/dev/tracks")({
  validateSearch: Schema.toStandardSchemaV1(TracksSearch),
  component: TracksPage,
});

function TracksPage() {
  const { columns } = Route.useSearch();

  if (Bench === undefined) return null;

  return (
    <Suspense fallback={null}>
      <Bench columns={columns ?? "4"} />
    </Suspense>
  );
}

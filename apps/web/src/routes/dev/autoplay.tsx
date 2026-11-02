import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { Suspense, lazy } from "react";

const Bench = import.meta.env.DEV
  ? lazy(() => import("@/dev/autoplay-bench").then((module) => ({ default: module.AutoplayBench })))
  : undefined;

const AutoplaySearch = Schema.Struct({
  still: Schema.optionalKey(Schema.Literals(["art", "none", "broken"])),
  title: Schema.optionalKey(Schema.Literals(["short", "long"])),
  overview: Schema.optionalKey(Schema.Literal("none")),
  seconds: Schema.optionalKey(
    Schema.Literals(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]),
  ),
  role: Schema.optionalKey(Schema.Literals(["advance", "follow", "unavailable"])),
});

/**
 * The player's next-episode card over a still frame: `/dev/autoplay?still=none&title=long`.
 * Development builds only.
 */
export const Route = createFileRoute("/dev/autoplay")({
  validateSearch: Schema.toStandardSchemaV1(AutoplaySearch),
  component: AutoplayPage,
});

function AutoplayPage() {
  const search = Route.useSearch();

  if (Bench === undefined) return null;

  return (
    <Suspense fallback={null}>
      <Bench
        still={search.still ?? "art"}
        title={search.title ?? "short"}
        overview={search.overview === undefined}
        seconds={Number(search.seconds ?? "10")}
        role={search.role ?? "advance"}
      />
    </Suspense>
  );
}

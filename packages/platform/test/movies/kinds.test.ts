import { describe, expect, it } from "vitest";

import { KINDS, kindDef } from "../../convex/core/jobs/kinds";

describe("movies job kinds", () => {
  it("run each kind in its ADR 0014 pool", () => {
    const pools = Object.fromEntries(
      KINDS.filter((def) => !def.kind.startsWith("probe.")).map((def) => [def.kind, def.pool]),
    );

    expect(pools).toEqual({
      "movies.scan": "movies",
      "movies.metadata": "movies",
      "movies.person": "movies",
      "movies.trickplay": "movies.background",
      "music.scan": "music",
      "server.backup": "server",
    });
  });

  it("collapse a second job for the same title, person, file, or server backup", () => {
    const payloads = [
      { kind: "movies.metadata", titleId: "t", match: null },
      { kind: "movies.person", personId: "p" },
      { kind: "movies.trickplay", fileId: "f" },
      { kind: "server.backup", trigger: "manual" },
    ] as const;

    expect(payloads.map((payload) => kindDef(payload.kind).dedupeKey(payload))).toEqual([
      "movies.metadata:t",
      "movies.person:p",
      "movies.trickplay:f",
      "server.backup:server",
    ]);
  });
});

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
      "movies.import.jellyfin": "movies",
      "movies.import.plex": "movies",
      "music.scan": "music",
      "server.backup": "server",
    });
  });

  it("collapse a second job only for the same title and match, person, or file as it is now", () => {
    const payloads = [
      { kind: "movies.metadata", titleId: "t", match: null, revision: 1, generation: 0 },
      { kind: "movies.metadata", titleId: "t", match: null, revision: 2, generation: 0 },
      {
        kind: "movies.metadata",
        titleId: "t",
        match: { provider: "tmdb", providerId: "603" },
        revision: 1,
        generation: 0,
      },
      { kind: "movies.person", personId: "p", revision: 1 },
      { kind: "movies.person", personId: "p", revision: 2 },
      { kind: "movies.trickplay", fileId: "f", revision: "10:1" },
      { kind: "movies.trickplay", fileId: "f", revision: "20:2" },
      { kind: "movies.import.jellyfin", source: "jellyfin", serverId: "den" },
      { kind: "movies.import.plex", source: "plex", serverId: "den" },
      { kind: "server.backup", trigger: "manual" },
    ] as const;

    expect(payloads.map((payload) => kindDef(payload.kind).dedupeKey(payload))).toEqual([
      "movies.metadata:t:1:0:refresh",
      "movies.metadata:t:2:0:refresh",
      "movies.metadata:t:1:0:tmdb:603",
      "movies.person:p:1",
      "movies.person:p:2",
      "movies.trickplay:f:10:1",
      "movies.trickplay:f:20:2",
      "movies.import.jellyfin:den",
      "movies.import.plex:den",
      "server.backup:server",
    ]);
  });
});

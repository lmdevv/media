import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer, Stream } from "effect";

import { MediaFileId, PlaybackSessionId } from "@media/contracts/ids";
import type { SessionStatus } from "@media/contracts/models/scan";
import { EpochMillis, Milliseconds } from "@media/contracts/units";

import * as SessionReports from "../playback/session-reports.ts";
import { SessionReport } from "../playback/stream-liveness.ts";
import * as MemoryBackend from "../testing/memory-backend.ts";
import * as ConvexSessionReports from "./convex-session-reports.ts";

const SESSION = PlaybackSessionId.make("session-a");

const ENDED_AT = 1_800_000_000_000;

const row = (overrides: Partial<SessionStatus>): SessionStatus => ({
  sessionId: SESSION,
  status: "active",
  fileId: MediaFileId.make("file-a"),
  endedAt: null,
  state: "playing",
  positionMs: Milliseconds.make(5_000),
  ...overrides,
});

describe("Convex session reports", () => {
  it.effect("reports play state and position, and ends with the session or without one", () =>
    Effect.gen(function* () {
      const asked: Array<string> = [];

      const rows = [
        row({}),
        row({ state: "paused" }),
        row({ status: "ended", endedAt: EpochMillis.make(ENDED_AT) }),
        null,
      ];

      const backend = MemoryBackend.layer(
        {},
        {
          "mediaService.sessionStatus": ({ sessionId }) => {
            asked.push(sessionId);

            return Stream.fromIterable(rows).pipe(Stream.concat(Stream.never));
          },
        },
      );

      const context = yield* Layer.build(ConvexSessionReports.layer.pipe(Layer.provide(backend)));

      const reports = yield* Context.get(context, SessionReports.Service)
        .follow(SESSION)
        .pipe(Stream.take(rows.length), Stream.runCollect);

      const playing = SessionReport.Active({ state: "playing", positionMs: 5_000 });

      assert.deepStrictEqual(asked, [SESSION]);
      assert.deepStrictEqual(reports, [
        playing,
        SessionReport.Active({ state: "paused", positionMs: 5_000 }),
        SessionReport.Ended(),
        SessionReport.Ended(),
      ]);
    }),
  );
});

/**
 * The `music.lyrics` job on the core's worker protocol (ADR 0012): one LRCLIB lookup of one song,
 * replacing old music's lyrics worker. It asks LRCLIB through the paced client and sends what the
 * try learned to `music/lyricLookups:settle`, which stores the answer and ends the job in one
 * mutation, so a server stopped before that call leaves the job to run again and one stopped
 * after it never asks LRCLIB for that song again.
 */
import { serverFunctions } from "@media/contracts/server-functions";
import type { LyricsTry } from "@media/contracts/server-functions";
import { Effect, Option, Predicate, Schedule } from "effect";

import * as CoreJobs from "../../core/core-jobs.ts";
import { JobFailed, Settled } from "../../core/core-jobs.ts";
import * as CoreSession from "../../core/core-session.ts";
import { LrclibClient } from "./lrclib-client.ts";
import { LrclibLyrics } from "./lrclib-record.ts";

const answered = (answer: Extract<LyricsTry, { outcome: "answered" }>["answer"]): LyricsTry => ({
  outcome: "answered",
  answer,
});

/** A lookup's answer as the core stores it; a record without lyrics counts as a miss. */
const tryOf = (lyrics: Option.Option<LrclibLyrics>): LyricsTry =>
  Option.match(lyrics, {
    onNone: () => answered({ status: "miss" }),
    onSome: LrclibLyrics.$match({
      Found: ({ recordId, sets }) => answered({ status: "found", recordId, sets }),
      Instrumental: ({ recordId }) => answered({ status: "instrumental", recordId }),
      Empty: () => answered({ status: "miss" }),
    }),
  });

/** Tries of a `settle` whose answer was lost on the way; a repeat after a commit answers lost. */
const SETTLE_RETRY = Schedule.exponential("500 millis").pipe(Schedule.upTo({ times: 5 }));

/** The `music.lyrics` handler, over the server's LRCLIB client. */
export const handler = Effect.gen(function* () {
  const session = yield* CoreSession.Service;
  const lrclib = yield* LrclibClient;

  return CoreJobs.handler({
    kind: "music.lyrics",
    run: Effect.fn("LyricsJob.run")(function* (job) {
      const result = yield* lrclib.lookup(job.payload.query).pipe(
        Effect.map(tryOf),
        Effect.catchTags({
          LrclibUnavailable: (error) =>
            Effect.logWarning("LyricsJob.lrclib_unavailable", error).pipe(
              Effect.as<LyricsTry>({
                outcome: "unavailable",
                error: error.message,
                pauseMs: Math.ceil(error.pauseMs),
              }),
            ),
          LrclibMalformed: (error) =>
            Effect.logWarning("LyricsJob.lrclib_malformed", error).pipe(
              Effect.as<LyricsTry>({ outcome: "failed", error: error.message }),
            ),
        }),
      );

      const settled = yield* session
        .call(serverFunctions.musicLyricsSettle, { lease: job.lease, result })
        .pipe(
          Effect.retry({
            while: (error) => Predicate.isTagged(error, "TransportError"),
            schedule: SETTLE_RETRY,
          }),
          Effect.mapError((error) => new JobFailed({ message: error.message, retry: true })),
          Effect.flatMap(CoreJobs.held),
        );

      return new Settled({ outcome: settled.saved });
    }),
  });
});

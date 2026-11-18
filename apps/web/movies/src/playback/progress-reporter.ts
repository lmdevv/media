import type { ProgressEvent } from "@media/contracts/models/playback";
import type { PlayerEvent, PlayerPort } from "@media/sdk/effect";
import { Playback } from "@media/sdk/effect";

import type { CoreStart, PlayCommands } from "./play-session";

const EXIT_REPORT_TIMEOUT_MS = 2_000;

const EVENT_REPORTS: Readonly<Record<PlayerEvent, ProgressEvent | null>> = {
  playing: "resume",
  paused: "pause",
  seeked: "seek",
  ended: "ended",
  waiting: null,
};

/** What a report names of the start it belongs to. */
export interface ReportedStart {
  readonly file: Pick<CoreStart["file"], "id">;
  readonly playbackId: CoreStart["playbackId"];
  readonly startedAt: CoreStart["startedAt"];
}

/** Stops reporting; resolves once the last report went out or gave up. */
export type StopReporting = () => Promise<void>;

/**
 * Reports `start`'s progress on `player` with `movies.play.report` until stopped: every
 * `Playback.PROGRESS_INTERVAL_MS` while playing, and on pause, resume, seek, and end. Stopping
 * reports where playback stopped, waiting at most two seconds for it. A report that fails is
 * skipped; the next one carries the position again.
 */
export const reportProgress = (
  report: PlayCommands["report"],
  start: ReportedStart,
  player: PlayerPort,
): StopReporting => {
  const send = (event: ProgressEvent): Promise<void> =>
    report({
      fileId: start.file.id,
      positionMs: Math.round(Math.max(0, player.positionMs())),
      event,
      playbackId: start.playbackId,
      startedAt: start.startedAt,
    }).then(
      () => undefined,
      () => undefined,
    );

  const unsubscribe = player.subscribe((event) => {
    const kind = EVENT_REPORTS[event];

    if (kind !== null) void send(kind);
  });

  const ticker = setInterval(() => {
    if (!player.isPaused()) void send("tick");
  }, Playback.PROGRESS_INTERVAL_MS);

  let stopped: Promise<void> | null = null;

  return () => {
    stopped ??= (() => {
      unsubscribe();
      clearInterval(ticker);

      return Promise.race([
        send("pause"),
        new Promise<void>((resolve) => {
          setTimeout(resolve, EXIT_REPORT_TIMEOUT_MS);
        }),
      ]);
    })();

    return stopped;
  };
};

import type { Episode } from "@media/contracts/models/catalog";
import { Button } from "@media/ui/components/button";
import { cn } from "@media/ui/lib/utils";
import { PlayIcon, TvIcon } from "lucide-react";
import { useId } from "react";

import { episodeCode, facts, formatRuntime } from "@/lib/format";

import { AUTOPLAY_COUNTDOWN } from "./autoplay";

/**
 * What this viewer can do about the countdown, `countdownMs` before the next episode starts.
 * `advance`: playing on their own, or hosting a room (for everyone in it), they play the next
 * episode now or watch the credits instead. `follow`: a room's guest sees the host's countdown and
 * can only close the card on this screen. `unavailable`: the next episode cannot play (`reason`),
 * so nothing counts down and the card only closes.
 */
export type NextEpisodeActions =
  | {
      readonly kind: "advance";
      readonly countdownMs: number;
      readonly onPlayNext: () => void;
      readonly onWatchCredits: () => void;
    }
  | { readonly kind: "follow"; readonly countdownMs: number; readonly onClose: () => void }
  | { readonly kind: "unavailable"; readonly reason: string; readonly onClose: () => void };

/** The parts of the next episode the card shows. */
export type NextEpisode = Pick<
  Episode,
  "seasonNumber" | "episodeNumber" | "name" | "overview" | "runtimeMs"
>;

/**
 * The card over the playing credits, in the bottom corner (across the bottom on phones held
 * upright).
 *
 * @param still - The next episode's still, sized for a card; without one, or while it fails to
 *   load, the tile shows a glyph.
 */
export function AutoplayNext({
  next,
  still,
  actions,
}: {
  readonly next: NextEpisode;
  readonly still: string | undefined;
  readonly actions: NextEpisodeActions;
}) {
  return (
    <div className="on-media pointer-events-none absolute inset-0 p-4 font-sans md:p-12 short:p-4">
      <div className="flex size-full items-end justify-end pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)]">
        <section
          aria-label="Next episode"
          data-slot="next-episode"
          className="pointer-events-auto flex w-full max-w-full flex-col gap-4 rounded-card bg-dark-surface-raised p-4 shadow-overlay md:w-(--spacing-next-card) md:p-5 short:w-(--spacing-next-card)"
        >
          <p className="text-caption/caption font-semibold tracking-caps text-text-muted uppercase">
            Next episode
          </p>
          <div className="flex items-start gap-4">
            <div
              data-slot="next-episode-still"
              className="relative flex aspect-video w-28 max-w-1/3 shrink-0 short:w-20 items-center justify-center overflow-hidden rounded-poster bg-text/5 text-text-muted"
            >
              <TvIcon aria-hidden className="size-6" />
              {still === undefined ? null : (
                <div
                  aria-hidden
                  data-slot="next-episode-image"
                  className="absolute inset-0 bg-cover bg-center"
                  style={{ backgroundImage: `url("${still}")` }}
                />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-label/label text-text-muted tabular-nums">
                {facts(
                  episodeCode(next),
                  next.runtimeMs === null ? null : formatRuntime(next.runtimeMs),
                )}
              </p>
              <h2 className="line-clamp-2 short:line-clamp-1 text-heading/heading font-bold tracking-tight wrap-break-word text-text">
                {next.name}
              </h2>
            </div>
          </div>
          {next.overview === null ? null : (
            <p className="line-clamp-2 text-label/label text-text-muted short:hidden">
              {next.overview}
            </p>
          )}
          <CardActions actions={actions} />
        </section>
      </div>
    </div>
  );
}

const startsIn = (countdownMs: number): string => {
  const seconds = secondsLeft(countdownMs);

  return `Starts in ${String(seconds)} ${seconds === 1 ? "second" : "seconds"}`;
};

const secondsLeft = (countdownMs: number): number => Math.max(0, Math.ceil(countdownMs / 1000));

function CardActions({ actions }: { readonly actions: NextEpisodeActions }) {
  const describedBy = useId();

  if (actions.kind === "unavailable") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p
          data-slot="next-episode-reason"
          className="min-w-0 grow text-body/4.5 font-semibold text-text"
        >
          {actions.reason}
        </p>
        <Button variant="secondary" size="md" onClick={actions.onClose}>
          Close
        </Button>
      </div>
    );
  }

  if (actions.kind === "follow") {
    return (
      <div className="flex flex-wrap gap-3">
        <p
          role="timer"
          aria-label={startsIn(actions.countdownMs)}
          className="relative isolate flex h-11 grow items-center justify-center gap-2 overflow-hidden rounded-control bg-text/10 px-5 text-body/4.5 font-semibold text-text"
        >
          <CountdownFill countdownMs={actions.countdownMs} className="bg-text/15" />
          Starts in
          <Seconds value={secondsLeft(actions.countdownMs)} />
        </p>
        <Button variant="secondary" size="md" className="grow" onClick={actions.onClose}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-3">
      <Button
        variant="inverse"
        size="md"
        className="relative isolate grow overflow-hidden bg-text/70 hover:bg-text/80"
        autoFocus
        aria-describedby={describedBy}
        onClick={actions.onPlayNext}
      >
        <CountdownFill countdownMs={actions.countdownMs} className="bg-text" />
        <PlayIcon aria-hidden className="fill-current" />
        <span>Play next</span>
        <Seconds value={secondsLeft(actions.countdownMs)} />
      </Button>
      {/* Outside the button, so it describes Play next without joining its name; hidden, so it is
          read only as that description. */}
      <span id={describedBy} hidden>
        {startsIn(actions.countdownMs)}
      </span>
      <Button variant="secondary" size="md" className="grow" onClick={actions.onWatchCredits}>
        Watch credits
      </Button>
    </div>
  );
}

const gone = (countdownMs: number): string =>
  String(Math.min(1, Math.max(0, 1 - countdownMs / AUTOPLAY_COUNTDOWN.totalMs)));

function CountdownFill({
  countdownMs,
  className,
}: {
  readonly countdownMs: number;
  readonly className: string;
}) {
  const fill = cn("absolute inset-0 -z-10 origin-left", className);

  return (
    <>
      <span
        aria-hidden
        data-slot="countdown-fill"
        className={cn(
          fill,
          "transition-[scale] ease-linear starting:scale-x-0! motion-reduce:hidden",
        )}
        // The starting style outranks this, so the fill opens empty and glides from there.
        style={{
          scale: `${gone(countdownMs - AUTOPLAY_COUNTDOWN.stepMs)} 1`,
          transitionDuration: `${String(AUTOPLAY_COUNTDOWN.stepMs)}ms`,
        }}
      />
      <span
        aria-hidden
        className={cn(fill, "motion-safe:hidden")}
        style={{ scale: `${gone(countdownMs)} 1` }}
      />
    </>
  );
}

function Seconds({ value }: { readonly value: number }) {
  return (
    <span
      aria-hidden
      data-slot="countdown-seconds"
      className="w-7 shrink-0 text-center tabular-nums"
    >
      {value}
    </span>
  );
}

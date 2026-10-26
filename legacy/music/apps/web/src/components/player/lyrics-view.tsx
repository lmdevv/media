import { TrackLyrics } from "@music/commands/lyrics";
import type { LyricLine } from "@music/commands/lyrics";
import { lyricLineState, lyricsCaption, lyricsMoment } from "@music/player/lyrics";
import type { LyricLineState, LyricsAnswer, LyricsMoment } from "@music/player/lyrics";
import { useLatestPlayer, usePositionReader } from "@music/player/react";
import { Spinner } from "@music/ui/components/spinner";
import { cn } from "@music/ui/lib/utils";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { formatDuration } from "@/lib/format";

import { perform } from "./player-actions";

/** Which Now Playing shows the lyrics: desktop (Paper 05 · 01b) or phone (05 · 04b). */
export type LyricsLayout = "desktop" | "phone";

/** The look of each layout, from Paper. */
const LAYOUTS = {
  desktop: {
    line: "font-sans text-lyric leading-2xl font-heavy tracking-tight",
    lines: "gap-6.5",
    states: { past: "text-text/28", active: "text-text", upcoming: "text-text/45" },
    plain: "font-sans text-xl/xl font-heavy tracking-tight text-text",
    plainLead: "h-12",
    /** The space above the first line; the sung line sits at `anchor` of the pane's height. */
    lead: "h-1/2",
    anchor: 0.5,
  },
  phone: {
    line: "font-sans text-phone-lyric leading-9 font-heavy tracking-snug",
    lines: "gap-5.5",
    states: { past: "text-text/30", active: "text-text", upcoming: "text-text/40" },
    plain: "font-sans text-phone-title leading-7 font-heavy tracking-snug text-text",
    plainLead: "h-11",
    lead: "h-11",
    anchor: 0.25,
  },
} as const;

/** Keys that scroll the lyrics when focus is inside them. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

const prefersReducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The playing song's lyrics in Now Playing: synced lines that follow playback and seek when
 * chosen, plain text, a loading view while they are looked up, a note that there are none, or
 * that they failed to load.
 * Mount it with the song's ID as its `key`, so a new song starts at the top, following.
 */
export function LyricsPane({
  lyrics,
  layout,
  className,
}: {
  readonly lyrics: LyricsAnswer;
  readonly layout: LyricsLayout;
  readonly className?: string;
}) {
  return (
    <section aria-label="Lyrics" className={cn("flex min-h-0 min-w-0 flex-col", className)}>
      <LyricsBody lyrics={lyrics} layout={layout} />
    </section>
  );
}

function LyricsBody({
  lyrics,
  layout,
}: {
  readonly lyrics: LyricsAnswer;
  readonly layout: LyricsLayout;
}) {
  if (lyrics === "loading") return <LyricsMessage looking>Looking for lyrics…</LyricsMessage>;

  if (lyrics === "failed") return <LyricsMessage>Couldn't load the lyrics</LyricsMessage>;

  return TrackLyrics.match(lyrics, {
    Synced: ({ main, source }) => (
      <SyncedLyrics
        lines={main.body.lines}
        layout={layout}
        footer={<LyricsFooter caption={lyricsCaption("Synced", source)} />}
      />
    ),
    Plain: ({ main, source }) => (
      <PlainLyrics
        text={main.body.text}
        layout={layout}
        footer={<LyricsFooter caption={lyricsCaption("Plain", source)} />}
      />
    ),
    Pending: ({ fallback }) =>
      fallback === null ? (
        <LyricsMessage looking>Looking for lyrics…</LyricsMessage>
      ) : (
        <PlainLyrics
          text={fallback.body.text}
          layout={layout}
          footer={<LyricsFooter caption={lyricsCaption("Plain", "file")} looking />}
        />
      ),
    None: () => <LyricsMessage>No lyrics for this song</LyricsMessage>,
    Instrumental: () => <LyricsMessage>Instrumental</LyricsMessage>,
  });
}

/** The source caption, and a hint while better (synced) lyrics may still be found. */
function LyricsFooter({
  caption,
  looking = false,
}: {
  readonly caption: string;
  readonly looking?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 pt-6.5">
      <span className="font-mono text-xs/xs tracking-mono text-text-muted">{caption}</span>
      {looking ? (
        <span className="flex items-center gap-1.5 font-sans text-xs/xs text-text-muted">
          <Spinner label="Looking for synced lyrics" className="size-3 text-text-muted" />
          Looking for synced lyrics…
        </span>
      ) : null}
    </div>
  );
}

function LyricsMessage({
  looking = false,
  children,
}: {
  readonly looking?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex grow items-center justify-center gap-3 font-sans text-lg/lg font-semibold text-text/60"
    >
      {looking ? <Spinner label="Loading" className="size-5 text-text" /> : null}
      {children}
    </div>
  );
}

function PlainLyrics({
  text,
  layout,
  footer,
}: {
  readonly text: string;
  readonly layout: LyricsLayout;
  readonly footer: ReactNode;
}) {
  const look = LAYOUTS[layout];

  return (
    <>
      <div className="flex min-h-0 grow flex-col overflow-y-auto overscroll-contain [scrollbar-width:none]">
        <div aria-hidden className={cn("shrink-0", look.plainLead)} />
        <p className={cn("shrink-0 whitespace-pre-line", look.plain)}>{text}</p>
        <div aria-hidden className="h-12 shrink-0" />
      </div>
      {footer}
    </>
  );
}

/** How far (in CSS pixels) the scroll may sit from where following put it and still count as there. */
const SCROLL_SLACK_PX = 2;

/**
 * Where following last put the lines: nowhere yet (`initial`, placed at once), nowhere since the
 * user took over (`released`), or at `top`, `settling` while a smooth scroll there may still run.
 */
type Placement =
  | { readonly kind: "initial" }
  | { readonly kind: "released" }
  | { readonly kind: "placed"; readonly top: number; readonly settling: boolean };

/** The scroll position that puts line `started` at `anchor` of the pane's height (the top before the first). */
const followTop = (element: HTMLElement, started: number, anchor: number): number => {
  const line = started < 0 ? null : element.querySelector<HTMLElement>(`[data-line="${started}"]`);

  const top =
    line === null ? 0 : line.offsetTop + line.offsetHeight / 2 - element.clientHeight * anchor;

  return Math.min(Math.max(0, top), element.scrollHeight - element.clientHeight);
};

/**
 * Keeps line `started` in place while following. The lines are the user's as soon as they scroll
 * them: a wheel, touch, or scroll key stops a running follow scroll where it is before the user's
 * scroll starts, and a scroll no handler saw shows as the lines no longer being where following
 * put them, which stops following instead of scrolling back over it. A resize or a late font puts
 * the line back in place at once.
 */
function useLineFollow(started: number, anchor: number) {
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);
  const placement = useRef<Placement>({ kind: "initial" });
  const target = useRef({ started, anchor });

  const settle = useCallback((): void => {
    const element = scroller.current;
    const placed = placement.current;

    if (element === null || placed.kind !== "placed" || !placed.settling) return;
    element.scrollTo({ top: element.scrollTop, behavior: "instant" });
    placement.current = { kind: "placed", top: element.scrollTop, settling: false };
  }, []);

  const release = useCallback((): void => {
    settle();
    placement.current = { kind: "released" };
    setFollowing(false);
  }, [settle]);

  useLayoutEffect(() => {
    target.current = { started, anchor };
    const element = scroller.current;
    const placed = placement.current;

    if (!following || element === null) return;

    if (
      placed.kind === "placed" &&
      !placed.settling &&
      Math.abs(element.scrollTop - placed.top) > SCROLL_SLACK_PX
    ) {
      release();

      return;
    }

    const top = followTop(element, started, anchor);

    const smooth =
      placed.kind !== "initial" &&
      !prefersReducedMotion() &&
      Math.abs(top - element.scrollTop) > SCROLL_SLACK_PX;

    element.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
    placement.current = { kind: "placed", top, settling: smooth };
  }, [started, anchor, following, release]);

  useEffect(() => {
    const element = scroller.current;
    const lines = list.current;

    if (element === null || lines === null) return undefined;

    const onScrollEnd = (): void => {
      const placed = placement.current;

      if (placed.kind === "placed" && Math.abs(element.scrollTop - placed.top) <= SCROLL_SLACK_PX) {
        placement.current = { ...placed, settling: false };
      }
    };

    const resized = new ResizeObserver(() => {
      if (placement.current.kind !== "placed") return;
      const top = followTop(element, target.current.started, target.current.anchor);

      element.scrollTo({ top, behavior: "instant" });
      placement.current = { kind: "placed", top, settling: false };
    });

    element.addEventListener("scrollend", onScrollEnd);
    resized.observe(element);
    resized.observe(lines);

    return () => {
      element.removeEventListener("scrollend", onScrollEnd);
      resized.disconnect();
    };
  }, []);

  useEffect(() => {
    const element = scroller.current;

    if (!following || element === null) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (SCROLL_KEYS.has(event.key)) release();
    };

    // Not passive, only while following: the browser applies the wheel's scroll after this runs,
    // so a follow scroll already under way stops first instead of overriding it.
    element.addEventListener("wheel", release, { passive: false });
    element.addEventListener("touchstart", settle, { passive: true });
    element.addEventListener("touchmove", release, { passive: true });
    element.addEventListener("keydown", onKeyDown);

    return () => {
      element.removeEventListener("wheel", release);
      element.removeEventListener("touchstart", settle);
      element.removeEventListener("touchmove", release);
      element.removeEventListener("keydown", onKeyDown);
    };
  }, [following, release, settle]);

  const follow = useCallback((): void => {
    const element = scroller.current;
    const placed = placement.current;

    // Choosing a line takes the lines on from wherever they are, even moved by a scroll no
    // handler saw; a follow scroll still under way keeps its own target.
    if (element !== null && placed.kind === "placed" && !placed.settling) {
      placement.current = { ...placed, top: element.scrollTop };
    }

    setFollowing(true);
  }, []);

  return { scroller, list, following, follow, release };
}

/**
 * Timed lines that follow playback. Each animation frame reads the live position and re-renders
 * only when another line starts or the sung one ends. The last line to start stays in place
 * (`useLineFollow`) until the user scrolls the lines; "Back to current line", or choosing a line,
 * follows again.
 */
function SyncedLyrics({
  lines,
  layout,
  footer,
}: {
  readonly lines: ReadonlyArray<LyricLine>;
  readonly layout: LyricsLayout;
  readonly footer: ReactNode;
}) {
  const readPosition = usePositionReader();
  const latestPlayer = useLatestPlayer();
  const [moment, setMoment] = useState(() => lyricsMoment(lines, readPosition()));
  const look = LAYOUTS[layout];
  const { scroller, list, following, follow, release } = useLineFollow(moment.started, look.anchor);

  useEffect(() => {
    let shown: LyricsMoment | null = null;

    let frame = requestAnimationFrame(function tick() {
      const next = lyricsMoment(lines, readPosition());

      if (shown === null || next.started !== shown.started || next.sung !== shown.sung) {
        shown = next;
        setMoment(next);
      }

      frame = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [lines, readPosition]);

  const seek = useCallback(
    (startMs: number) => {
      perform(latestPlayer().seek(startMs));
      follow();
    },
    [latestPlayer, follow],
  );

  return (
    <>
      <div className="relative flex min-h-0 grow flex-col">
        <div
          ref={scroller}
          className="relative flex min-h-0 grow flex-col overflow-y-auto overscroll-contain [scrollbar-width:none]"
          onFocus={(event) => {
            // Moving to a line by keyboard scrolls it into view; following would scroll it away.
            if (event.target !== event.currentTarget && event.target.matches(":focus-visible")) {
              release();
            }
          }}
        >
          <div aria-hidden className={cn("shrink-0", look.lead)} />
          <ol ref={list} className={cn("flex shrink-0 flex-col", look.lines)}>
            {lines.map((line, index) => {
              const state = lyricLineState(index, moment);

              return (
                <li key={index} className="flex">
                  <LineButton
                    index={index}
                    text={line.text}
                    startMs={line.startMs}
                    state={state}
                    className={cn(look.line, look.states[state])}
                    onSeek={seek}
                  />
                </li>
              );
            })}
          </ol>
          <div aria-hidden className="h-1/2 shrink-0" />
        </div>
        {following ? null : (
          <button
            type="button"
            onClick={follow}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-text/14 px-3.5 py-1.75 font-sans text-sm/xs font-medium text-text shadow-glass backdrop-blur-sm outline-none hover:bg-text/20 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Back to current line
          </button>
        )}
      </div>
      {footer}
    </>
  );
}

/** One timed line: choosing it (click, Enter, or Space) seeks to where it starts. */
const LineButton = memo(function LineButton({
  index,
  text,
  startMs,
  state,
  className,
  onSeek,
}: {
  readonly index: number;
  readonly text: string;
  readonly startMs: number;
  readonly state: LyricLineState;
  readonly className: string;
  readonly onSeek: (startMs: number) => void;
}) {
  const blank = text.trim() === "";

  return (
    <button
      type="button"
      data-line={index}
      aria-label={`${blank ? "Instrumental" : text}, seek to ${formatDuration(startMs)}`}
      aria-current={state === "active" ? "true" : undefined}
      onClick={() => onSeek(startMs)}
      className={cn(
        "rounded-md text-left whitespace-pre-line outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
        state === "active" ? null : "hover:text-text/70",
        className,
      )}
    >
      {blank ? "♪" : text}
    </button>
  );
});

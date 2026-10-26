/**
 * Lyrics inside Now Playing (B12–B16, H13), as Apple Music shows them: the Lyrics button in the
 * bottom row, and under the song's row the source caption, then synced lines that follow playback
 * and seek when tapped, plain text, or what there is to say instead. The rules for the button,
 * the caption, and the sung line are the web's, from `@music/player/lyrics`.
 */
import type { LyricLine } from "@music/commands/lyrics";
import { TrackLyrics } from "@music/commands/lyrics";
import { lyricLineState, lyricsButton, lyricsCaption, lyricsMoment } from "@music/player/lyrics";
import type { LyricLineState, LyricsAnswer, LyricsMoment, LyricsOffer } from "@music/player/lyrics";
import * as Haptics from "expo-haptics";
import { ArrowUp, MessageSquareQuote } from "lucide-react-native";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollViewInstance,
} from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { anchorTop, followLines, LINES_WAITING } from "@/lib/lyrics-follow";
import type { LineBox, LineFollow, LineFollowEvent } from "@/lib/lyrics-follow";
import { clock } from "@/lib/playback-format";
import { useThemeColor } from "@/lib/theme-color";
import { usePlayerActions, usePositionReader } from "@/player";

import { EdgeFade } from "./edge-fade";

/**
 * Opens and closes the lyrics: dimmed and disabled for a song without lyrics or an instrumental
 * (B15), a spinner while they are looked up (B16), and on a faint wash while open (B12).
 */
export function LyricsButton({
  offer,
  open,
  onPress,
}: {
  readonly offer: LyricsOffer;
  readonly open: boolean;
  readonly onPress: () => void;
}) {
  const button = lyricsButton(offer, open);
  const color = useThemeColor("--color-text");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={button.label}
      accessibilityState={{ selected: open, disabled: button.disabled, busy: button.loading }}
      disabled={button.disabled}
      onPress={onPress}
      className={`size-hit-target items-center justify-center rounded-full active:opacity-60 ${open ? "bg-text/10" : ""} ${button.disabled ? "opacity-disabled" : ""}`}
    >
      {button.loading ? (
        <ActivityIndicator color={color} accessibilityElementsHidden />
      ) : (
        <Icon icon={MessageSquareQuote} />
      )}
    </Pressable>
  );
}

/**
 * The playing song's lyrics under its row: synced lines, plain text, the song's own plain text
 * while synced lyrics are looked up, or a note that there are none, that this is an instrumental,
 * or that they failed to load. Mount it with the song's ID as its `key`, so a new song starts at
 * the top, following. `background` is the sheet's color, for the fades at the edges.
 */
export function LyricsPanel({
  lyrics,
  background,
}: {
  readonly lyrics: LyricsAnswer;
  readonly background: string;
}) {
  if (lyrics === "loading") return <LyricsMessage looking>Looking for lyrics…</LyricsMessage>;

  if (lyrics === "failed") return <LyricsMessage>Couldn’t load the lyrics</LyricsMessage>;

  return TrackLyrics.match(lyrics, {
    Synced: ({ main, source }) => (
      <>
        <Caption text={lyricsCaption("Synced", source)} />
        <SyncedLyrics lines={main.body.lines} background={background} />
      </>
    ),
    Plain: ({ main, source }) => (
      <>
        <Caption text={lyricsCaption("Plain", source)} />
        <PlainLyrics text={main.body.text} background={background} />
      </>
    ),
    Pending: ({ fallback }) =>
      fallback === null ? (
        <LyricsMessage looking>Looking for lyrics…</LyricsMessage>
      ) : (
        <>
          <Caption text={lyricsCaption("Plain", "file")} looking />
          <PlainLyrics text={fallback.body.text} background={background} />
        </>
      ),
    None: () => <LyricsMessage>No lyrics for this song</LyricsMessage>,
    Instrumental: () => <LyricsMessage>Instrumental</LyricsMessage>,
  });
}

/** The source caption over the lines, and a note while synced lyrics may still be found. */
function Caption({ text, looking = false }: { readonly text: string; readonly looking?: boolean }) {
  const muted = useThemeColor("--color-text-muted");

  return (
    <View className="flex-row items-center gap-3 pt-3 pb-1">
      <Text variant="mono" tone="muted">
        {text}
      </Text>
      {looking ? (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" color={muted} accessibilityElementsHidden />
          <Text variant="caption" tone="muted">
            Looking for synced lyrics…
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function LyricsMessage({
  looking = false,
  children,
}: {
  readonly looking?: boolean;
  readonly children: string;
}) {
  const muted = useThemeColor("--color-text-muted");

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={children}
      className="flex-1 flex-row items-center justify-center gap-3"
    >
      {looking ? <ActivityIndicator color={muted} /> : null}
      <Text variant="bodyStrong" tone="muted">
        {children}
      </Text>
    </View>
  );
}

/** Untimed lyrics to read and scroll (B13), a stanza to each blank-line-separated block. */
function PlainLyrics({ text, background }: { readonly text: string; readonly background: string }) {
  const stanzas = text.split(/\n\s*\n/u).filter((stanza) => stanza.trim() !== "");

  return (
    <View className="min-h-0 flex-1">
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-6 pt-6 pr-6 pb-12"
      >
        {stanzas.map((stanza, index) => (
          <Text key={index} variant="lyricPlain">
            {stanza}
          </Text>
        ))}
      </ScrollView>
      <EdgeFade edge="top" background={background} />
      <EdgeFade edge="bottom" background={background} />
    </View>
  );
}

/** How long a follow scroll may take to land before following counts it as over. */
const SETTLE_MS = 1000;

/**
 * Keeps line `started` at the anchor by wiring the lines' scroll view to `followLines`: it
 * measures the lines, reports every scroll, drag, and scroll end, and makes the scrolls following
 * asks for, without animating under Reduce Motion (`animate` false).
 */
function useLineFollow(started: number, animate: boolean) {
  const scroller = useRef<ScrollViewInstance>(null);
  const [following, setFollowing] = useState(true);
  const [height, setHeight] = useState(0);
  const state = useRef<LineFollow>(LINES_WAITING);
  const sung = useRef(started);
  const motion = useRef(animate);
  const viewport = useRef(0);
  const content = useRef(0);
  const boxes = useRef<Array<LineBox | undefined>>([]);
  const relayout = useRef<number | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const topOf = useCallback(
    (index: number): number | null =>
      anchorTop(
        { viewport: viewport.current, content: content.current, lines: boxes.current },
        index,
      ),
    [],
  );

  const dispatch = useCallback(function dispatch(event: LineFollowEvent): void {
    const step = followLines(state.current, event);
    state.current = step.state;
    setFollowing(step.state.kind !== "released");

    if (step.scroll === undefined) return;
    scroller.current?.scrollTo({
      y: step.scroll.top,
      animated: step.scroll.animated && motion.current,
    });

    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = null;
      dispatch({ type: "scrollSettled" });
    }, SETTLE_MS);
  }, []);

  useEffect(() => {
    motion.current = animate;
  }, [animate]);

  useLayoutEffect(() => {
    sung.current = started;
    dispatch({ type: "started", top: topOf(started) });
  }, [started, dispatch, topOf]);

  useEffect(
    () => () => {
      if (relayout.current !== null) cancelAnimationFrame(relayout.current);

      if (settle.current !== null) clearTimeout(settle.current);
    },
    [],
  );

  /** After any layout change, puts the line back on the next frame, once per frame. */
  const laidOut = useCallback((): void => {
    if (relayout.current !== null) return;

    relayout.current = requestAnimationFrame(() => {
      relayout.current = null;
      dispatch({ type: "laidOut", top: topOf(sung.current) });
    });
  }, [dispatch, topOf]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent): void => {
      viewport.current = event.nativeEvent.layout.height;
      setHeight(event.nativeEvent.layout.height);
      laidOut();
    },
    [laidOut],
  );

  const onContentSizeChange = useCallback(
    (_width: number, contentHeight: number): void => {
      content.current = contentHeight;
      laidOut();
    },
    [laidOut],
  );

  const onLineLayout = useCallback(
    (index: number, box: LineBox): void => {
      boxes.current[index] = box;
      laidOut();
    },
    [laidOut],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
      dispatch({ type: "scrolled", offset: event.nativeEvent.contentOffset.y });
    },
    [dispatch],
  );

  const onScrollBeginDrag = useCallback((): void => {
    dispatch({ type: "dragged" });
  }, [dispatch]);

  const onMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
      dispatch({ type: "scrolled", offset: event.nativeEvent.contentOffset.y });
    },
    [dispatch],
  );

  const follow = useCallback((): void => {
    dispatch({ type: "follow", top: topOf(sung.current) });
  }, [dispatch, topOf]);

  return {
    scroller,
    following,
    follow,
    height,
    onLayout,
    onContentSizeChange,
    onLineLayout,
    onScroll,
    onScrollBeginDrag,
    onMomentumScrollEnd,
  };
}

/**
 * Timed lines that follow playback (B12). Each frame reads the live position and re-renders only
 * when another line starts or the sung one ends. The last line to start stays at the anchor
 * (`useLineFollow`) until anything else moves the lines; "Back to current line" (B14), or tapping
 * a line, follows again. Reduce Motion moves the lines without animating.
 */
function SyncedLyrics({
  lines,
  background,
}: {
  readonly lines: ReadonlyArray<LyricLine>;
  readonly background: string;
}) {
  const readPosition = usePositionReader();
  const { seek } = usePlayerActions();
  const reduceMotion = useReducedMotion();
  const [moment, setMoment] = useState(() => lyricsMoment(lines, readPosition()));
  const follow = useLineFollow(moment.started, !reduceMotion);

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

  const { follow: followAgain, onLineLayout } = follow;

  const onSeek = useCallback(
    (startMs: number) => {
      void Haptics.selectionAsync();
      void seek(startMs);
      followAgain();
    },
    [seek, followAgain],
  );

  return (
    <View className="min-h-0 flex-1">
      <ScrollView
        ref={follow.scroller}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onLayout={follow.onLayout}
        onContentSizeChange={follow.onContentSizeChange}
        onScroll={follow.onScroll}
        onScrollBeginDrag={follow.onScrollBeginDrag}
        onMomentumScrollEnd={follow.onMomentumScrollEnd}
        contentContainerClassName="gap-6 pt-6 pr-6"
      >
        {lines.map((line, index) => (
          <Line
            key={index}
            index={index}
            text={line.text}
            startMs={line.startMs}
            state={lyricLineState(index, moment)}
            onSeek={onSeek}
            onBox={onLineLayout}
          />
        ))}
        {/* Room under the last line, so it can reach the anchor too. */}
        <View style={{ height: follow.height }} />
      </ScrollView>
      <EdgeFade edge="top" background={background} />
      <EdgeFade edge="bottom" background={background} />
      {follow.following ? null : <BackToLine onPress={followAgain} />}
    </View>
  );
}

/** B12 dims past and upcoming lines alike, to `--opacity-disabled`; only the sung line is bright. */
const LINE_LOOK: Readonly<Record<LyricLineState, string>> = {
  past: "opacity-disabled",
  active: "",
  upcoming: "opacity-disabled",
};

/** One timed line: bright while sung, dimmed otherwise; tapping it seeks to where it starts. */
const Line = memo(function Line({
  index,
  text,
  startMs,
  state,
  onSeek,
  onBox,
}: {
  readonly index: number;
  readonly text: string;
  readonly startMs: number;
  readonly state: LyricLineState;
  readonly onSeek: (startMs: number) => void;
  readonly onBox: (index: number, box: LineBox) => void;
}) {
  const blank = text.trim() === "";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={blank ? "Instrumental" : text}
      accessibilityHint={`Plays from ${clock(startMs)}`}
      accessibilityState={{ selected: state === "active" }}
      onPress={() => {
        onSeek(startMs);
      }}
      onLayout={(event) => {
        const { y, height } = event.nativeEvent.layout;
        onBox(index, { y, height });
      }}
      className={LINE_LOOK[state]}
    >
      <Text variant="lyric">{blank ? "♪" : text}</Text>
    </Pressable>
  );
});

/** B14's pill over the lines once the person scrolled away: follows the sung line again. */
function BackToLine({ onPress }: { readonly onPress: () => void }) {
  return (
    <View className="absolute inset-x-0 bottom-3 items-center" pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to current line"
        onPress={onPress}
        className="h-ios-36 flex-row items-center gap-2 rounded-full bg-text pr-4 pl-3 shadow-lg shadow-glass-shadow active:opacity-80"
      >
        <Icon icon={ArrowUp} tone="inverse" size="meta" />
        <Text variant="secondaryStrong" tone="inverse">
          Back to current line
        </Text>
      </Pressable>
    </View>
  );
}

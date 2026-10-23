/**
 * The download glyphs of Paper's downloads proposal: the 24pt header ring beside More (D01, D04,
 * D18) and the 12pt glyph before a song row's subtitle (D01, D05, D06). Drawn rather than taken
 * from Lucide, since the ring fills by progress. Light follows Apple Music, where a downloaded song
 * is a quiet grey arrow; dark follows Spotify, where it is green, and the ring's track sits on the
 * raised surface (D18).
 */
import type { TrackDownloadState } from "@music/sdk/downloads";
import { useEffect } from "react";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useUniwind } from "uniwind";

import type { DownloadRing } from "@/lib/download-control";
import { useThemeColor } from "@/lib/theme-color";

/** Paper's ring: radius 10 on the 24-unit grid, 2 wide, starting at 12 o'clock. */
const RING_RADIUS = 10;

const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** The arrow inside the idle and downloaded rings. */
const ARROW = "M12 7.5v8.5M8.5 12.75 12 16.25l3.5-3.5";

/** Paper's row glyph: radius 5 on a 12-unit grid, 1.5 wide; a downloading arc covers 60%. */
const ROW_LENGTH = 2 * Math.PI * 5;

/** The colors that differ between the two themes. */
const useDownloadColors = () => {
  const dark = useUniwind().theme === "dark";

  return {
    track: useThemeColor(dark ? "--color-surface-raised" : "--color-border"),
    doneFill: useThemeColor(dark ? "--color-accent" : "--color-text-muted"),
    doneMark: useThemeColor(dark ? "--color-on-accent" : "--color-bg"),
  };
};

/** The header ring: idle arrow, dashed waiting ring, progress ring with stop, or filled arrow. */
export function DownloadRingGlyph({ ring }: { readonly ring: DownloadRing }) {
  const { track } = useDownloadColors();
  const text = useThemeColor("--color-text");
  const muted = useThemeColor("--color-text-muted");
  const accent = useThemeColor("--color-accent");
  const onAccent = useThemeColor("--color-on-accent");

  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      {ring.kind === "idle" ? (
        <>
          <Circle cx={12} cy={12} r={9.5} stroke={text} strokeWidth={1.75} />
          <Path
            d={ARROW}
            stroke={text}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
      {ring.kind === "waiting" ? (
        <>
          <Circle
            cx={12}
            cy={12}
            r={RING_RADIUS}
            stroke={muted}
            strokeWidth={2}
            strokeDasharray="2 3.24"
          />
          <Rect x={9} y={9} width={6} height={6} rx={1} fill={muted} />
        </>
      ) : null}
      {ring.kind === "downloading" ? (
        <>
          <Circle cx={12} cy={12} r={RING_RADIUS} stroke={track} strokeWidth={2} />
          {/* A round cap would draw an empty arc as a dot. */}
          {ring.progress > 0 ? (
            <Circle
              cx={12}
              cy={12}
              r={RING_RADIUS}
              stroke={accent}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={`${String(ring.progress * RING_LENGTH)} ${String(RING_LENGTH)}`}
              transform="rotate(-90 12 12)"
            />
          ) : null}
          <Rect x={9} y={9} width={6} height={6} rx={1} fill={accent} />
        </>
      ) : null}
      {ring.kind === "downloaded" ? (
        <>
          <Circle cx={12} cy={12} r={10.5} fill={accent} />
          <Path
            d={ARROW}
            stroke={onAccent}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
    </Svg>
  );
}

/**
 * The 12pt arc of a song downloading. A song's own bytes aren't tracked, so the arc turns rather
 * than fills; it holds still when Reduce Motion is on.
 */
function DownloadingArc() {
  const { track } = useDownloadColors();
  const accent = useThemeColor("--color-accent");
  const reduceMotion = useReducedMotion();
  const turn = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return undefined;

    turn.set(withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1));

    return () => cancelAnimation(turn);
  }, [reduceMotion, turn]);

  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${String(turn.get())}deg` }] }));

  return (
    <Animated.View style={spin}>
      <Svg width={12} height={12} viewBox="0 0 12 12" fill="none">
        <Circle cx={6} cy={6} r={5} stroke={track} strokeWidth={1.5} />
        <Circle
          cx={6}
          cy={6}
          r={5}
          stroke={accent}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={`${String(ROW_LENGTH * 0.6)} ${String(ROW_LENGTH)}`}
          transform="rotate(-90 6 6)"
        />
      </Svg>
    </Animated.View>
  );
}

/** The glyph before a song row's subtitle while this phone holds or is getting the song. */
export function TrackDownloadGlyph({ state }: { readonly state: TrackDownloadState }) {
  const { doneFill, doneMark } = useDownloadColors();
  const muted = useThemeColor("--color-text-muted");
  const danger = useThemeColor("--color-danger");
  const onAccent = useThemeColor("--color-on-accent");

  if (state === "downloading") return <DownloadingArc />;

  return (
    <Svg width={12} height={12} viewBox="0 0 12 12" fill="none">
      {state === "downloaded" ? (
        <>
          <Circle cx={6} cy={6} r={6} fill={doneFill} />
          <Path
            d="M6 3v5M3.9 6.1 6 8.2l2.1-2.1"
            stroke={doneMark}
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
      {state === "queued" ? (
        <Circle cx={6} cy={6} r={5} stroke={muted} strokeWidth={1.5} strokeDasharray="1.6 2.3" />
      ) : null}
      {state === "failed" ? (
        <>
          <Circle cx={6} cy={6} r={6} fill={danger} />
          <Path d="M6 3.2v3.3" stroke={onAccent} strokeWidth={1.4} strokeLinecap="round" />
          <Circle cx={6} cy={8.6} r={0.8} fill={onAccent} />
        </>
      ) : null}
    </Svg>
  );
}

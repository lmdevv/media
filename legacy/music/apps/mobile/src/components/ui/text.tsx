/**
 * Text in Paper's iOS type scale (page 12 · 04): Inter at 34/40 for large titles, 22/28 for
 * section headings, 16/24 for body and rows, 14/20 for labels, 13/18 for secondary lines, and
 * Geist Mono 12/16 for metadata. Each weight is its own font file, so weight lives in the variant.
 */
import type { ReactNode } from "react";
import { Text as NativeText } from "react-native";
import type { TextProps as NativeTextProps } from "react-native";

const VARIANTS = {
  /** Welcome's display headline (E01): 40/44 heavy, display tracking. */
  display: "font-sans-heavy text-2xl leading-2xl tracking-display",
  /** Tab root titles and entry heroes: 34/40 heavy, display tracking. */
  largeTitle: "font-sans-heavy text-mobile-title leading-mobile-title tracking-display",
  /** Heroes Paper draws without tracking (setup steps, reset, settings heroes): 34/40 heavy. */
  hero: "font-sans-heavy text-mobile-title leading-mobile-title",
  /** A large progress figure, such as a scan's or job's percent: 64/64 heavy. */
  figure: "font-sans-heavy text-display leading-display",
  /** Empty-state titles and large sheet titles: 28/32 heavy. */
  title: "font-sans-heavy text-xl leading-xl",
  /** A synced lyric line in Now Playing (B12): 28/32 heavy, tight tracking. */
  lyric: "font-sans-heavy text-xl leading-xl tracking-tight",
  /** Plain lyrics in Now Playing (B13): 20/28 semibold, tight tracking. */
  lyricPlain: "font-sans-semibold text-lg leading-lg tracking-tight",
  /** The inline title beside a back button: 22/28 heavy, display tracking. */
  navTitle: "font-sans-heavy text-mobile-section leading-mobile-section tracking-display",
  /** Now Playing's song title: 22/28 heavy, with no tracking (B01). */
  songTitle: "font-sans-heavy text-mobile-section leading-mobile-section",
  /** Section headers and sheet titles: 22/28 heavy, tight tracking. */
  section: "font-sans-heavy text-mobile-section leading-mobile-section tracking-tight",
  /** A heading inside a sheet, such as the queue's "Playing Next" (B03): 16/24 heavy. */
  subheading: "font-sans-heavy text-md leading-md",
  /** Body copy and field values: 16/24 regular. */
  body: "font-sans text-md leading-md",
  /** Row titles: 16/24 medium. */
  bodyMedium: "font-sans-medium text-md leading-md",
  /** Button labels, card titles, the active row, and the compact nav title: 16/24 semibold. */
  bodyStrong: "font-sans-semibold text-md leading-md",
  /** Summary lines and sheet subtitles: 14/20 regular. */
  callout: "font-sans text-base leading-base",
  /** Error lines under a form: 14/20 medium. */
  calloutMedium: "font-sans-medium text-base leading-base",
  /** Field labels, notice titles, and the mini player title: 14/20 semibold. */
  label: "font-sans-semibold text-base leading-base",
  /** Row subtitles and notice bodies: 13/18 regular. */
  secondary: "font-sans text-sm leading-sm",
  /** Chip labels and text links such as See all: 13/18 semibold. */
  secondaryStrong: "font-sans-semibold text-sm leading-sm",
  /** The mini player's artist line: 12/16 regular. */
  caption: "font-sans text-xs leading-xs",
  /** Metadata in caps, such as `FLAC · 16-BIT`: Geist Mono 12/16, mono tracking. */
  mono: "font-mono text-xs leading-xs tracking-mono",
} as const;

const TONES = {
  default: "text-text",
  muted: "text-text-muted",
  accent: "text-accent",
  danger: "text-danger",
  success: "text-success",
  onAccent: "text-on-accent",
  /** The page color on a text-colored fill, such as a selected chip. */
  inverse: "text-text-inverse",
  /** White in both modes, over artwork darkened by the scrim (A08b's hero). */
  overArt: "text-dark-text",
} as const;

/** A step of the type scale. */
type TextVariant = keyof typeof VARIANTS;

/** A text color role. */
export type TextTone = keyof typeof TONES;

/** Props for `Text`. */
export interface TextProps extends Omit<NativeTextProps, "children"> {
  readonly variant?: TextVariant;
  readonly tone?: TextTone;
  readonly children?: ReactNode;
}

/**
 * Text in the app's type scale and color roles. Extra classes may set layout, not type or color.
 * Dynamic Type stays on, capped so 34pt titles still fit a phone.
 */
export function Text({ variant = "body", tone = "default", className, ...props }: TextProps) {
  return (
    <NativeText
      className={`${VARIANTS[variant]} ${TONES[tone]} ${className ?? ""}`}
      maxFontSizeMultiplier={1.6}
      {...props}
    />
  );
}

/**
 * Text in the iOS type scale from Paper's foundations board (`01 · iOS Foundations & Components`):
 * Inter Tight at 34/40 for large titles, 22/28 for section headings, 17/23 for body, 15/21 for
 * labels and 13/19 for metadata. Each weight is its own font file, so weight lives in the variant.
 */
import type { ReactNode } from "react";
import { Text as NativeText } from "react-native";
import type { TextProps as NativeTextProps } from "react-native";

const VARIANTS = {
  hero: "font-sans-heavy text-display leading-display tracking-display",
  displayName: "font-sans-bold text-display leading-display tracking-display",
  display: "font-sans-bold text-ios-40 leading-ios-46 tracking-display",
  heroTitle: "font-sans-bold text-ios-48 leading-ios-54 tracking-display",
  billboard: "font-sans-bold text-display leading-display tracking-display",
  wordmark: "font-sans-heavy text-ios-48 leading-ios-54",
  largeTitle: "font-sans-bold text-ios-34 leading-ios-40 tracking-display",
  title: "font-sans-bold text-ios-28 leading-ios-34",
  navTitle: "font-sans-semibold text-heading leading-heading",
  keypad: "font-sans-medium text-ios-28 leading-ios-34",
  subheading: "font-sans-semibold text-ios-22 leading-ios-28",
  heading: "font-sans-bold text-ios-22 leading-ios-28",
  body: "font-sans text-ios-17 leading-ios-23",
  bodyMedium: "font-sans-medium text-ios-17 leading-ios-23",
  bodyStrong: "font-sans-semibold text-ios-17 leading-ios-23",
  label: "font-sans-medium text-body leading-ios-21",
  secondary: "font-sans text-body leading-ios-21",
  paragraph: "font-sans text-body leading-body",
  labelStrong: "font-sans-semibold text-body leading-ios-21",
  meta: "font-sans text-label leading-ios-19",
  metaStrong: "font-sans-medium text-label leading-ios-19",
  metaSemibold: "font-sans-semibold text-label leading-ios-19",
  railCardName:
    "font-sans-medium text-body leading-ios-21 regular:font-sans-semibold regular:text-ios-17 regular:leading-ios-23",
  posterCaption:
    "font-sans-medium text-label leading-ios-19 regular:text-body regular:leading-ios-21",
  status: "font-sans-semibold text-ios-22 leading-ios-28",
  caption: "font-sans-medium text-caption leading-caption",
  mono: "font-mono text-label leading-ios-19",
  monoMedium: "font-mono-medium text-label leading-ios-19",
} as const;

const TONES = {
  default: "text-text",
  muted: "text-text-muted",
  accent: "text-accent",
  danger: "text-danger",
  success: "text-success",
  onAccent: "text-on-accent",
  onMedia: "text-dark-text",
  onMediaMuted: "text-video-muted",
  inverse: "text-bg",
  darkMuted: "text-dark-text-muted",
  darkDanger: "text-dark-danger",
} as const;

type TextVariant = keyof typeof VARIANTS;

/** A text color role. */
export type TextTone = keyof typeof TONES;

/** Props for `Text`. */
export interface TextProps extends Omit<NativeTextProps, "children"> {
  readonly variant?: TextVariant;
  readonly tone?: TextTone;
  readonly children?: ReactNode;
}

/** Text in the app's type scale and color roles. Extra classes may set layout, not type or color. */
export function Text({ variant = "body", tone = "default", className, ...props }: TextProps) {
  return (
    <NativeText
      className={`${VARIANTS[variant]} ${TONES[tone]} ${className ?? ""}`}
      maxFontSizeMultiplier={1.6}
      {...props}
    />
  );
}

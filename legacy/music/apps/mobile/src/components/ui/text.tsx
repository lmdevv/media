import type { ReactNode } from "react";
import { Text as NativeText } from "react-native";
import type { TextProps as NativeTextProps } from "react-native";

const VARIANTS = {
  display: "font-sans-heavy text-2xl leading-2xl tracking-display",
  largeTitle: "font-sans-heavy text-mobile-title leading-mobile-title tracking-display",
  hero: "font-sans-heavy text-mobile-title leading-mobile-title",
  figure: "font-sans-heavy text-display leading-display",
  title: "font-sans-heavy text-xl leading-xl",
  lyric: "font-sans-heavy text-xl leading-xl tracking-tight",
  panelHeading: "font-sans-heavy text-lg leading-lg tracking-tight",
  lyricPlain: "font-sans-semibold text-lg leading-lg tracking-tight",
  navTitle: "font-sans-heavy text-mobile-section leading-mobile-section tracking-display",
  songTitle: "font-sans-heavy text-mobile-section leading-mobile-section",
  subtitle: "font-sans-medium text-lg leading-lg",
  section: "font-sans-heavy text-mobile-section leading-mobile-section tracking-tight",
  subheading: "font-sans-heavy text-md leading-md",
  body: "font-sans text-md leading-md",
  bodyMedium: "font-sans-medium text-md leading-md",
  bodyStrong: "font-sans-semibold text-md leading-md",
  callout: "font-sans text-base leading-base",
  calloutMedium: "font-sans-medium text-base leading-base",
  label: "font-sans-semibold text-base leading-base",
  secondary: "font-sans text-sm leading-sm",
  secondaryMedium: "font-sans-medium text-sm leading-sm",
  secondaryStrong: "font-sans-semibold text-sm leading-sm",
  sidebarRow: "font-sans text-base leading-sm",
  wordmark: "font-mono-medium text-md leading-base",
  caption: "font-sans text-xs leading-xs",
  mono: "font-mono text-xs leading-xs tracking-mono",
} as const;

const TONES = {
  default: "text-text",
  muted: "text-text-muted",
  accent: "text-accent",
  danger: "text-danger",
  success: "text-success",
  onAccent: "text-on-accent",
  inverse: "text-text-inverse",
  overArt: "text-dark-text",
} as const;

/** A step of the type scale. */
type TextVariant = keyof typeof VARIANTS;

/** A text color role. */
export type TextTone = keyof typeof TONES;

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

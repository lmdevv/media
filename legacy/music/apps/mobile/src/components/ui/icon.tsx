import type { LucideIcon } from "lucide-react-native";

import { useThemeColor } from "@/lib/theme-color";

import type { TextTone } from "./text";

/** The theme color a glyph takes in each text tone. */
export const TONE_VARIABLES = {
  default: "--color-text",
  muted: "--color-text-muted",
  accent: "--color-accent",
  danger: "--color-danger",
  success: "--color-success",
  onAccent: "--color-on-accent",
  inverse: "--color-text-inverse",
  overArt: "--color-dark-text",
} as const satisfies Record<TextTone, `--color-${string}`>;

const SIZES = {
  meta: 16,
  field: 18,
  inline: 20,
  side: 22,
  nav: 24,
  barSkip: 26,
  transport: 32,
  hero: 48,
  state: 64,
} as const;

/** A step of the glyph size scale. */
export type IconSize = keyof typeof SIZES;

export interface IconProps {
  readonly icon: LucideIcon;
  readonly tone?: TextTone;
  readonly size?: IconSize;
  /** Transport glyphs (play, pause, forward) are drawn filled. */
  readonly filled?: boolean;
}

/** A Lucide glyph colored by role, hidden from VoiceOver (its control carries the label). */
export function Icon({ icon: Glyph, tone = "default", size = "nav", filled = false }: IconProps) {
  const color = useThemeColor(TONE_VARIABLES[tone]);

  return (
    <Glyph
      size={SIZES[size]}
      strokeWidth={1.75}
      color={color}
      fill={filled ? color : "none"}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}

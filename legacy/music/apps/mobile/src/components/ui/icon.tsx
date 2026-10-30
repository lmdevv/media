/**
 * Lucide glyphs at Paper's 1.75 stroke, colored by a text role so they follow the theme. Paper
 * draws its content icons on lucide's 24-unit grid; native chrome (tabs, menus) uses SF Symbols.
 */
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

/**
/**
 * Glyph sizes as Paper draws them: 16 beside inline metadata (a playlist's lock); 18 in the iPad
 * sidebar's search field and heading; 20 in buttons, fields, notices, and trailing row slots; 22
 * in the iPad sidebar's rows and the player bar's buttons; 24 in navigation, tabs, and leading row
 * slots; 26 for the player bar's previous and next; 32 for Now Playing's previous and next; 48 for
 * entry heroes and Now Playing's play button; 64 for empty states. Lucide takes a point size, so
 * the scale lives here rather than in CSS.
 */
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

/** Props for `Icon`. */
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

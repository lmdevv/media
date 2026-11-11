import type { LucideIcon } from "lucide-react-native";

import { useThemeColor } from "@/lib/theme-color";

import type { TextTone } from "./text";

const TONE_VARIABLES = {
  default: "--color-text",
  muted: "--color-text-muted",
  accent: "--color-accent",
  danger: "--color-danger",
  success: "--color-success",
  onAccent: "--color-on-accent",
  onMedia: "--color-dark-text",
  onMediaMuted: "--color-video-muted",
  inverse: "--color-bg",
  darkMuted: "--color-dark-text-muted",
  darkDanger: "--color-dark-danger",
} as const satisfies Record<TextTone, string>;

/**
 * Glyph sizes as Paper draws them: 14 under profile tiles, 16 for row chevrons, 20 in buttons and
 * on artwork, 22 in list rows, 24 in navigation, 28 large controls, 32 in the round badge of calm
 * states and for the player's skip buttons and spinner, 40 on small avatar tiles, 52 for the
 * player's play and pause, and 56 on large tiles. Lucide takes a point size, so the scale lives
 * here rather than in CSS.
 */
const SIZES = {
  caption: 14,
  chevron: 16,
  inline: 20,
  row: 22,
  nav: 24,
  large: 28,
  badge: 32,
  control: 32,
  state: 40,
  transport: 52,
  tile: 56,
} as const;

type IconSize = keyof typeof SIZES;

/** Props for `Icon`. */
export interface IconProps {
  readonly icon: LucideIcon;
  readonly tone?: TextTone;
  readonly size?: IconSize;
  readonly filled?: boolean;
}

/** A Lucide glyph colored by role. */
export function Icon({ icon: Glyph, tone = "default", size = "nav", filled = false }: IconProps) {
  const color = useThemeColor(TONE_VARIABLES[tone]);

  return (
    <Glyph
      size={SIZES[size]}
      strokeWidth={2}
      color={color}
      fill={filled ? color : "none"}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}

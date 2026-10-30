/**
 * Round icon actions with Paper's 44pt hit target: the back chevron, a nav bar's trailing glyph,
 * a sheet's close button. The label is required: VoiceOver reads it, and tests select by it.
 */
import type { LucideIcon } from "lucide-react-native";
import { ActivityIndicator, Pressable } from "react-native";
import type { PressableProps } from "react-native";

import { useThemeColor } from "@/lib/theme-color";

import { Icon, TONE_VARIABLES } from "./icon";
import type { IconSize } from "./icon";
import type { TextTone } from "./text";

/** Props for `IconButton`. */
export interface IconButtonProps extends Omit<PressableProps, "children" | "style"> {
  readonly icon: LucideIcon;
  /** What VoiceOver reads, such as `Back`. */
  readonly label: string;
  readonly tone?: TextTone;
  /** 24 in navigation (the default), 20 for inline actions such as pause in the merged bar. */
  readonly size?: Extract<IconSize, "nav" | "inline">;
  readonly filled?: boolean;
  /** Shows a spinner in place of the icon while what it opens is looked up. */
  readonly loading?: boolean;
  readonly className?: string;
}

function Spinner({ tone }: { readonly tone: TextTone }) {
  const color = useThemeColor(TONE_VARIABLES[tone]);

  return <ActivityIndicator size="small" color={color} />;
}

/** A 44pt round icon action with pressed feedback. */
export function IconButton({
  icon,
  label,
  tone = "default",
  size = "nav",
  filled = false,
  loading = false,
  className,
  accessibilityState,
  ...props
}: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={loading ? { ...accessibilityState, busy: true } : accessibilityState}
      className={`size-hit-target items-center justify-center rounded-full active:opacity-60 ${className ?? ""}`}
      {...props}
    >
      {loading ? (
        <Spinner tone={tone} />
      ) : (
        <Icon icon={icon} tone={tone} size={size} filled={filled} />
      )}
    </Pressable>
  );
}

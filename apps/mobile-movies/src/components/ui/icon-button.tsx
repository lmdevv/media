import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { LucideIcon } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import type { PressableProps } from "react-native";

import { Icon } from "./icon";

/** Props for `IconButton`. */
export interface IconButtonProps extends Omit<PressableProps, "children" | "style"> {
  readonly icon: LucideIcon;
  /** What VoiceOver reads, such as `Back`. */
  readonly label: string;
  readonly variant?: "raised" | "glass" | "plain";
  readonly filled?: boolean;
  /** `regular` is 44pt, `control` 52pt beside a pill button (D01 My List), `large` 56pt. */
  readonly size?: "regular" | "control" | "large";
  readonly className?: string;
}

const liquidGlass = isLiquidGlassAvailable();

/** A round icon action with a 44pt hit area. */
export function IconButton({
  icon,
  label,
  variant = "raised",
  filled = false,
  size = "regular",
  className,
  ...props
}: IconButtonProps) {
  const dimension = { regular: "size-11", control: "size-13", large: "size-14" }[size];

  const glyph = (
    <Icon
      icon={icon}
      tone={variant === "glass" ? "onMedia" : "default"}
      size={size === "large" ? "large" : "nav"}
      filled={filled}
    />
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      className={`${dimension} items-center justify-center overflow-hidden rounded-pill active:opacity-70 ${
        variant === "raised" ? "bg-surface-raised/80" : ""
      } ${className ?? ""}`}
      {...props}
    >
      {variant === "glass" ? (
        liquidGlass ? (
          <GlassView
            glassEffectStyle="regular"
            colorScheme="dark"
            style={StyleSheet.absoluteFill}
          />
        ) : (
          <BlurView tint="dark" intensity={40} style={StyleSheet.absoluteFill} />
        )
      ) : null}
      <View>{glyph}</View>
    </Pressable>
  );
}

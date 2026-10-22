/**
 * Paper's pill buttons: 48pt tall, full radius, 16/24 semibold labels with an optional 20pt
 * leading icon. Primary is the accent fill, secondary the surface, destructive the surface with a
 * danger label (Paper never fills red). While an action runs the button shows its pending label
 * and ignores presses, so a form is never sent twice.
 */
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import { Pressable } from "react-native";
import type { PressableProps } from "react-native";

import { Icon } from "./icon";
import { Text } from "./text";
import type { TextTone } from "./text";

const VARIANTS = {
  primary: { box: "bg-accent", tone: "onAccent" },
  secondary: { box: "bg-surface", tone: "default" },
  destructive: { box: "bg-surface", tone: "danger" },
} as const satisfies Record<string, { readonly box: string; readonly tone: TextTone }>;

/** How a button looks. */
type ButtonVariant = keyof typeof VARIANTS;

/** Props for `Button`. */
export interface ButtonProps extends Omit<PressableProps, "children" | "style"> {
  readonly label: string;
  readonly variant?: ButtonVariant;
  readonly icon?: LucideIcon;
  /** Filled glyphs, such as the play triangle. */
  readonly iconFilled?: boolean;
  /** While true, shows `pendingLabel` and ignores presses. */
  readonly pending?: boolean;
  /** What the button says while its action runs, such as `Signing in…`. */
  readonly pendingLabel?: string;
  readonly className?: string;
}

/** A full-width pill action with pressed feedback, and a light haptic on primary actions. */
export function Button({
  label,
  variant = "primary",
  icon,
  iconFilled = false,
  pending = false,
  pendingLabel,
  disabled,
  className,
  onPress,
  ...props
}: ButtonProps) {
  const { box, tone } = VARIANTS[variant];
  const inactive = disabled === true || pending;
  const shown = pending ? (pendingLabel ?? label) : label;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={shown}
      accessibilityState={{ disabled: inactive, busy: pending }}
      disabled={inactive}
      onPress={(event) => {
        if (variant === "primary") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress?.(event);
      }}
      className={`h-12 flex-row items-center justify-center gap-2 rounded-full px-mobile-edge py-3 active:opacity-80 ${box} ${
        disabled === true ? "opacity-disabled" : pending ? "opacity-muted" : ""
      } ${className ?? ""}`}
      {...props}
    >
      {icon === undefined || pending ? null : (
        <Icon icon={icon} tone={tone} size="inline" filled={iconFilled} />
      )}
      <Text variant="bodyStrong" tone={tone} numberOfLines={1}>
        {shown}
      </Text>
    </Pressable>
  );
}

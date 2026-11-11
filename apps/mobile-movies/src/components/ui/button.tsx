import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable } from "react-native";
import type { PressableProps } from "react-native";

import { Icon } from "./icon";
import { Text } from "./text";
import type { TextTone } from "./text";

const VARIANTS = {
  primary: { box: "bg-accent active:bg-accent-pressed", tone: "onAccent" },
  secondary: { box: "bg-surface-raised active:opacity-80", tone: "default" },
  destructive: { box: "border border-danger active:opacity-70", tone: "danger" },
  plain: { box: "active:opacity-60", tone: "default" },
  plainDestructive: { box: "active:opacity-60", tone: "danger" },
  glass: { box: "bg-glass active:opacity-80", tone: "onMedia" },
  onDark: { box: "bg-dark-surface-raised active:opacity-80", tone: "onMedia" },
} as const satisfies Record<string, { box: string; tone: TextTone }>;

type ButtonVariant = keyof typeof VARIANTS;

/** Props for `Button`. */
export interface ButtonProps extends Omit<PressableProps, "children" | "style"> {
  readonly label: string;
  readonly variant?: ButtonVariant;
  readonly icon?: LucideIcon | undefined;
  /** Filled icons, such as the play triangle, draw with a fill instead of a stroke. */
  readonly iconFilled?: boolean;
  /** Shows a spinner and ignores presses while an action runs. */
  readonly busy?: boolean;
  readonly className?: string;
  readonly trailing?: ReactNode;
}

const SPINNER_COLOR = {
  onAccent: "accent-on-accent",
  default: "accent-text",
  danger: "accent-danger",
  onMedia: "accent-dark-text",
} as const satisfies Partial<Record<TextTone, string>>;

/** A full-width pill action. */
export function Button({
  label,
  variant = "primary",
  icon,
  iconFilled = false,
  busy = false,
  disabled,
  className,
  onPress,
  trailing,
  ...props
}: ButtonProps) {
  const { box, tone } = VARIANTS[variant];
  const inactive = disabled === true || busy;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={(event) => {
        if (variant === "primary") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress?.(event);
      }}
      className={`h-13 flex-row items-center justify-center gap-2 rounded-pill px-6 ${box} ${
        disabled === true ? "opacity-40" : ""
      } ${className ?? ""}`}
      {...props}
    >
      {busy ? (
        <ActivityIndicator colorClassName={SPINNER_COLOR[tone]} />
      ) : (
        <>
          {icon === undefined ? null : (
            <Icon icon={icon} tone={tone} size="inline" filled={iconFilled} />
          )}
          <Text variant="bodyStrong" tone={tone} numberOfLines={1}>
            {label}
          </Text>
          {trailing}
        </>
      )}
    </Pressable>
  );
}

import { ChevronRight } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { Icon } from "./icon";
import { Text } from "./text";
import type { TextTone } from "./text";

/** Props for `ListRow`. */
export interface ListRowProps {
  readonly title: string;
  readonly icon?: LucideIcon | undefined;
  /** Draws the icon filled, such as the play triangle of Autoplay Next Episode. */
  readonly iconFilled?: boolean | undefined;
  readonly detail?: string | undefined;
  /** A second line under the title. */
  readonly subtitle?: string | undefined;
  readonly tone?: TextTone;
  readonly chevron?: boolean;
  readonly trailing?: ReactNode;
  readonly onPress?: (() => void) | undefined;
  readonly disabled?: boolean;
  /** Marks the chosen row of a picker for VoiceOver, such as the selected streaming quality. */
  readonly selected?: boolean;
}

/** One row of a list. */
export function ListRow({
  title,
  icon,
  iconFilled = false,
  detail,
  subtitle,
  tone = "default",
  chevron = true,
  trailing,
  onPress,
  disabled = false,
  selected,
}: ListRowProps) {
  const content = (
    <>
      {icon === undefined ? null : (
        <View className="w-7 items-center">
          <Icon icon={icon} tone={tone} size="row" filled={iconFilled} />
        </View>
      )}
      <View className="flex-1 gap-0.5">
        <Text tone={tone} numberOfLines={1}>
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text variant="meta" tone="muted" numberOfLines={2}>
            {subtitle}
          </Text>
        )}
      </View>
      {detail === undefined ? null : (
        <Text variant="secondary" tone="muted" numberOfLines={1}>
          {detail}
        </Text>
      )}
      {trailing}
      {chevron && onPress !== undefined ? (
        <View className="w-5 items-center">
          <Icon icon={ChevronRight} tone="muted" size="chevron" />
        </View>
      ) : null}
    </>
  );

  if (onPress === undefined) {
    return <View className="min-h-14 flex-row items-center gap-3">{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail === undefined ? title : `${title}, ${detail}`}
      accessibilityState={selected === undefined ? { disabled } : { disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-14 flex-row items-center gap-3 active:opacity-60 ${disabled ? "opacity-40" : ""}`}
    >
      {content}
    </Pressable>
  );
}

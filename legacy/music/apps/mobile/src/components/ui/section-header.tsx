/**
 * Paper's section header: a 22/28 heavy title with tight tracking and either a 20pt chevron (the
 * whole row opens the section) or an accent text action such as See all or Manage.
 */
import { ChevronRight } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "./icon";
import { Text } from "./text";

/** What the header's trailing side does. */
export type SectionAction =
  | { readonly kind: "chevron"; readonly onPress: () => void }
  | { readonly kind: "link"; readonly label: string; readonly onPress: () => void };

/** Props for `SectionHeader`. */
export interface SectionHeaderProps {
  readonly title: string;
  readonly action?: SectionAction | undefined;
  /** Home's first header sits 16pt under the title; the rest 20pt under the content above. */
  readonly first?: boolean;
}

/** A section's heading, optionally opening the section or offering one action. */
export function SectionHeader({ title, action, first = false }: SectionHeaderProps) {
  const box = `flex-row items-center justify-between pb-2 ${first ? "pt-4" : "pt-mobile-edge"}`;

  const heading = (
    <Text variant="section" accessibilityRole="header" className="flex-1" numberOfLines={1}>
      {title}
    </Text>
  );

  if (action === undefined) return <View className={box}>{heading}</View>;

  if (action.kind === "chevron") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={action.onPress}
        className={`${box} active:opacity-60`}
      >
        {heading}
        <Icon icon={ChevronRight} size="inline" />
      </Pressable>
    );
  }

  return (
    <View className={box}>
      {heading}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${action.label}, ${title}`}
        onPress={action.onPress}
        hitSlop={12}
        className="active:opacity-60"
      >
        <Text variant="secondaryStrong" tone="accent">
          {action.label}
        </Text>
      </Pressable>
    </View>
  );
}

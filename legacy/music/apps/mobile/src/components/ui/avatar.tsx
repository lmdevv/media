import { View } from "react-native";

import { Text } from "./text";

const initialOf = (name: string): string => (name.trim().at(0) ?? "?").toLocaleUpperCase();

const LOOKS = {
  plain: { circle: "size-row bg-surface", variant: "bodyStrong", tone: "default" },
  solid: { circle: "size-hit-target bg-text", variant: "bodyStrong", tone: "inverse" },
  solidSmall: { circle: "size-8 bg-text", variant: "secondaryStrong", tone: "inverse" },
} as const;

/** A circle with the person's initial. Decorative: its button carries the label. */
export function Avatar({
  name,
  look = "plain",
}: {
  readonly name: string;
  readonly look?: keyof typeof LOOKS;
}) {
  const { circle, variant, tone } = LOOKS[look];

  return (
    <View
      className={`items-center justify-center rounded-full ${circle}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text variant={variant} tone={tone}>
        {initialOf(name)}
      </Text>
    </View>
  );
}

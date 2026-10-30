/**
 * The account's initial in a surface circle, as Paper draws "L" beside large titles. The iPad's
 * chrome draws it solid in the text color, in the sidebar's foot and the top of a page (page 26).
 */
import { View } from "react-native";

import { Text } from "./text";

/** The first letter of a display name, or of the email when there is no name. */
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

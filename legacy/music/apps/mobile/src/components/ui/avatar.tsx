/** The account's initial in a 40pt surface circle, as Paper draws "L" beside large titles. */
import { View } from "react-native";

import { Text } from "./text";

/** The first letter of a display name, or of the email when there is no name. */
const initialOf = (name: string): string => (name.trim().at(0) ?? "?").toLocaleUpperCase();

/** A 40pt circle with the person's initial. Decorative: its button carries the label. */
export function Avatar({ name }: { readonly name: string }) {
  return (
    <View
      className="size-row items-center justify-center rounded-full bg-surface"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text variant="bodyStrong">{initialOf(name)}</Text>
    </View>
  );
}

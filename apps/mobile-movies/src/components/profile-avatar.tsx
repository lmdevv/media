import { Text, View } from "react-native";

import { monogram } from "@/lib/avatars";

/**
 * A person's avatar: their name's first letter on the raised tile, as the web clients draw it.
 * VoiceOver reads the name beside it, so the tile itself is hidden.
 */
export function PersonAvatar({ name }: { readonly name: string }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="size-18 items-center justify-center overflow-hidden rounded-card bg-surface-raised"
    >
      <Text
        className="font-sans-bold text-ios-36 leading-ios-42 text-text"
        maxFontSizeMultiplier={1}
      >
        {monogram(name)}
      </Text>
    </View>
  );
}

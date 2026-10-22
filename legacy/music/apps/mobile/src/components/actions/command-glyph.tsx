/** The ⌘ glyph in the Actions nav bars (F26, F27): it marks the screen, and does nothing. */
import { Command } from "lucide-react-native";
import { View } from "react-native";

import { Icon } from "@/components/ui/icon";

/** The nav bar's trailing ⌘, centered in its 44pt slot. */
export function CommandGlyph() {
  return (
    <View className="flex-1 items-center justify-center">
      <Icon icon={Command} />
    </View>
  );
}

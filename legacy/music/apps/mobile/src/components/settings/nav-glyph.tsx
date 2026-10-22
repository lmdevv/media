/**
 * The 24pt glyph Paper puts in a nav bar's trailing slot when it names the screen rather than
 * acting (the gear on Administration, the folder on Add library). It does nothing, so VoiceOver
 * skips it.
 */
import type { LucideIcon } from "lucide-react-native";
import { View } from "react-native";

import { Icon } from "@/components/ui/icon";

/** A decorative nav bar glyph in Paper's 44pt slot. */
export function NavGlyph({ icon }: { readonly icon: LucideIcon }) {
  return (
    <View
      className="size-hit-target items-center justify-center"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon icon={icon} />
    </View>
  );
}

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

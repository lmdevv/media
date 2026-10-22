/**
 * Paper's ellipsis, opening a native iOS menu on tap. Paper draws the ellipsis on Now Playing and
 * the queue but not what it opens; a system menu is the iOS answer, so its items use SF Symbols.
 */
import { Button, Host, Menu, RNHostView } from "@expo/ui/swift-ui";
import { accessibilityLabel } from "@expo/ui/swift-ui/modifiers";
import { Ellipsis } from "lucide-react-native";
import type { ComponentProps } from "react";
import { View } from "react-native";

import { Icon } from "@/components/ui/icon";

/** An SF Symbol name, as the native menu takes it. */
type SFSymbol = NonNullable<ComponentProps<typeof Button>["systemImage"]>;

/** One action in the menu. */
export interface MenuItem {
  readonly title: string;
  readonly icon: SFSymbol;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}

/**
 * A 44pt ellipsis that opens `items`; `label` is what VoiceOver reads. The glyph is drawn in
 * React Native inside the menu's label, so the whole 44pt square takes the tap.
 */
export function MenuButton({
  label,
  items,
}: {
  readonly label: string;
  readonly items: ReadonlyArray<MenuItem>;
}) {
  return (
    <Host matchContents>
      <Menu
        label={
          <RNHostView matchContents>
            <View className="size-hit-target items-center justify-center" pointerEvents="none">
              <Icon icon={Ellipsis} />
            </View>
          </RNHostView>
        }
        modifiers={[accessibilityLabel(label)]}
      >
        {items.map((item) => (
          <Button
            key={item.title}
            label={item.title}
            systemImage={item.icon}
            role={item.destructive === true ? "destructive" : "default"}
            onPress={item.onPress}
          />
        ))}
      </Menu>
    </Host>
  );
}

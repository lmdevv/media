/**
 * A Downloaded row that can remove its download without opening it (Paper's D10d): swipe it left
 * to uncover Remove as the queue does (B04), or hold it. VoiceOver offers Remove download as an
 * action on the row.
 */
import type { ReactNode } from "react";
import { View } from "react-native";

import { SwipeToRemove } from "@/components/ui/swipe-to-remove";
import { useThemeColor } from "@/lib/theme-color";

/** The press and hold the row takes; a press on a swiped-open row only closes it. */
interface RowPress {
  readonly onPress: () => void;
  readonly onLongPress: (() => void) | undefined;
}

/** Props for `RemovableRow`. */
export interface RemovableRowProps {
  /** What VoiceOver reads for the row, which it reaches as one element. */
  readonly label: string;
  /** What the row shows; a recycled row starts closed when it changes. */
  readonly resetKey: string;
  readonly onPress: () => void;
  /** Called from a hold, the uncovered Remove, or the VoiceOver action. */
  readonly onRemove: (() => void) | undefined;
  readonly children: (press: RowPress) => ReactNode;
}

/** `children` as is without `onRemove`, else swipeable, holdable, and with a VoiceOver action. */
export function RemovableRow({ onRemove, ...row }: RemovableRowProps) {
  if (onRemove === undefined) return row.children({ onPress: row.onPress, onLongPress: undefined });

  return <SwipeableRow {...row} onRemove={onRemove} />;
}

function SwipeableRow({
  label,
  resetKey,
  onPress,
  onRemove,
  children,
}: Omit<RemovableRowProps, "onRemove"> & { readonly onRemove: () => void }) {
  const canvas = useThemeColor("--color-canvas");

  return (
    <SwipeToRemove swipeBack resetKey={resetKey} background={canvas} onRemove={onRemove}>
      {({ settle, remove }) => {
        const press = () => {
          if (!settle()) onPress();
        };

        return (
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityActions={[{ name: "remove", label: "Remove download" }]}
            onAccessibilityAction={remove}
            onAccessibilityTap={press}
          >
            {children({ onPress: press, onLongPress: remove })}
          </View>
        );
      }}
    </SwipeToRemove>
  );
}

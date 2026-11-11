import type { LucideIcon } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { PanResponder, View } from "react-native";
import type { GestureResponderEvent, HostInstance } from "react-native";

import { Icon } from "@/components/ui/icon";

/** Props for `VerticalSlider`. */
export interface VerticalSliderProps {
  readonly icon: LucideIcon;
  /** What VoiceOver reads, such as `Brightness`. */
  readonly label: string;
  /** From 0 to 1. */
  readonly value: number;
  readonly onChange: (value: number) => void;
  /** Called while the viewer drags, so the controls stay up. */
  readonly onInteract: () => void;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/** A level from 0 to 1, set by dragging along the track. */
export function VerticalSlider({ icon, label, value, onChange, onInteract }: VerticalSliderProps) {
  const track = useRef<HostInstance>(null);
  const bounds = useRef({ top: 0, height: 1 });
  const latest = useRef({ onChange, onInteract });

  useEffect(() => {
    latest.current = { onChange, onInteract };
  }, [onChange, onInteract]);

  const [responder] = useState(() => {
    const set = (event: GestureResponderEvent): void => {
      const { top, height } = bounds.current;

      latest.current.onInteract();
      latest.current.onChange(clamp(1 - (event.nativeEvent.pageY - top) / height));
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        set(event);
      },
      onPanResponderMove: (event) => {
        set(event);
      },
      onPanResponderTerminationRequest: () => false,
    });
  });

  return (
    <View
      className="w-11 items-center gap-3"
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => {
        onChange(clamp(value + (event.nativeEvent.actionName === "increment" ? 0.1 : -0.1)));
      }}
      {...responder.panHandlers}
    >
      <Icon icon={icon} tone="onMedia" size="row" />
      <View
        ref={track}
        onLayout={() => {
          track.current?.measureInWindow((_x, y, _width, height) => {
            bounds.current = { top: y, height: Math.max(1, height) };
          });
        }}
        className="h-23 w-1 justify-end overflow-hidden rounded-pill bg-dark-hairline"
      >
        <View
          className="w-full rounded-pill bg-dark-text"
          style={{ height: `${String(value * 100)}%` }}
        />
      </View>
    </View>
  );
}

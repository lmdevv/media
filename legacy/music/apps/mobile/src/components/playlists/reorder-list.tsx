/**
 * C07's editable rows, like iOS edit mode: a red remove button leading each row and a grip
 * trailing it. Dragging a grip lifts the row and slides the rows it passes out of its way, all on
 * the UI thread; dragging near the top or bottom edge scrolls the page. Dropping reports one move
 * (`from`, `to`); the parent reorders its list, and the rows settle into their new places.
 */
import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  scrollTo,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { AnimatedRef, SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import { Equal, X } from "lucide-react-native";

import { Icon } from "@/components/ui/icon";

/** How close to an edge of the screen, in points, a dragged row starts scrolling the page. */
const EDGE = 96;

/** The fastest the page scrolls under a dragged row, in points per frame. */
const MAX_SPEED = 14;

/** How long the rows a drag passes take to slide aside, in milliseconds. */
const SLIDE_MS = 160;

/** The drag in progress, shared by every row on the UI thread. */
interface Drag {
  /** The dragged row's index, or -1 while nothing is dragged. */
  readonly from: SharedValue<number>;
  /** Where the dragged row would land if dropped now. */
  readonly to: SharedValue<number>;
  /** How far the dragged row has moved from its place, scrolling included. */
  readonly offset: SharedValue<number>;
  /** The finger's travel since the drag began, without scrolling. */
  readonly travel: SharedValue<number>;
  /** The finger's height on screen, for scrolling at the edges. */
  readonly finger: SharedValue<number>;
  /** The page's scroll offset when the drag began. */
  readonly startScroll: SharedValue<number>;
  /** One row's height, measured from the first row. */
  readonly rowHeight: SharedValue<number>;
}

/** Where the dragged row lands for an offset: the slot its middle is over. */
const slotFor = (from: number, offset: number, height: number, count: number): number => {
  "worklet";

  return Math.max(0, Math.min(count - 1, from + Math.round(offset / Math.max(1, height))));
};

/** Props for one reorderable row. */
interface RowProps {
  readonly index: number;
  readonly count: number;
  readonly drag: Drag;
  readonly scroll: SharedValue<number>;
  readonly label: string;
  /** Draws the row's content around the grip it is given for its trailing lane. */
  readonly render: (grip: ReactNode) => ReactNode;
  readonly onLift: () => void;
  /** The finger left the grip, whether or not this row was being dragged. */
  readonly onRelease: () => void;
  readonly onRemove: () => void;
  readonly onDrop: (from: number, to: number) => void;
  readonly onLayout: ((event: LayoutChangeEvent) => void) | undefined;
}

function ReorderRow({
  index,
  count,
  drag,
  scroll,
  label,
  render,
  onLift,
  onRelease,
  onRemove,
  onDrop,
  onLayout,
}: RowProps) {
  const pan = usePanGesture({
    minDistance: 0,
    onActivate: () => {
      "worklet";
      drag.from.value = index;
      drag.to.value = index;
      drag.offset.value = 0;
      drag.travel.value = 0;
      drag.startScroll.value = scroll.value;
      scheduleOnRN(onLift);
    },
    onUpdate: (event) => {
      "worklet";
      drag.travel.value = event.translationY;
      drag.finger.value = event.absoluteY;
      drag.offset.value = event.translationY + scroll.value - drag.startScroll.value;
      drag.to.value = slotFor(index, drag.offset.value, drag.rowHeight.value, count);
    },
    onFinalize: () => {
      "worklet";
      scheduleOnRN(onRelease);

      if (drag.from.value !== index) return;
      const to = drag.to.value;

      // Settle into the slot first, then hand the move to React, which redraws the new order. A
      // settle cut short by the next drag hands nothing over.
      drag.offset.value = withTiming(
        (to - index) * drag.rowHeight.value,
        { duration: 120 },
        (finished) => {
          if (finished === true) scheduleOnRN(onDrop, index, to);
        },
      );
    },
  });

  const style = useAnimatedStyle(() => {
    const from = drag.from.value;

    if (from === -1) return { transform: [{ translateY: 0 }], zIndex: 0 };

    if (from === index) {
      return { transform: [{ translateY: drag.offset.value }, { scale: 1.02 }], zIndex: 10 };
    }

    const to = drag.to.value;
    const height = drag.rowHeight.value;
    const shift = from < index && index <= to ? -height : to <= index && index < from ? height : 0;

    return { transform: [{ translateY: withTiming(shift, { duration: SLIDE_MS }) }], zIndex: 0 };
  });

  return (
    <Animated.View
      style={style}
      onLayout={onLayout}
      className="flex-row items-center gap-2 bg-canvas"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${label}`}
        onPress={onRemove}
        hitSlop={12}
        className="w-mobile-edge items-center active:opacity-60"
      >
        <Icon icon={X} tone="danger" size="inline" />
      </Pressable>
      <View className="min-w-0 flex-1">
        {render(
          <GestureDetector gesture={pan}>
            <View
              accessible
              accessibilityLabel={`Reorder ${label}`}
              hitSlop={12}
              className="size-8 items-center justify-center"
            >
              <Icon icon={Equal} tone="muted" size="inline" />
            </View>
          </GestureDetector>,
        )}
      </View>
    </Animated.View>
  );
}

/** Props for `ReorderList`. */
export interface ReorderListProps<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly keyOf: (item: Item) => string;
  /** What VoiceOver calls a row, such as the song's title. */
  readonly labelOf: (item: Item) => string;
  /** The row after the remove button, with `grip` in its trailing lane. */
  readonly renderItem: (item: Item, grip: ReactNode) => ReactNode;
  readonly onMove: (from: number, to: number) => void;
  readonly onRemove: (item: Item) => void;
  /** The page's scroll view, which the list scrolls while a row is dragged near an edge. */
  readonly scrollRef: AnimatedRef<Animated.ScrollView>;
  /** The page's scroll offset. */
  readonly scroll: SharedValue<number>;
  /** The farthest the page scrolls: its content's height less its own. */
  readonly maxScroll: SharedValue<number>;
}

/** Rows that reorder by dragging their grips and leave by their remove buttons. */
export function ReorderList<Item>({
  items,
  keyOf,
  labelOf,
  renderItem,
  onMove,
  onRemove,
  scrollRef,
  scroll,
  maxScroll,
}: ReorderListProps<Item>) {
  const { height: screen } = useWindowDimensions();
  // Set by a drop; the next new order clears the drag. A list that changes under a drag, as when a
  // collaborator adds a song, leaves the drag alone.
  const dropped = useRef(false);

  const drag: Drag = {
    from: useSharedValue(-1),
    to: useSharedValue(-1),
    offset: useSharedValue(0),
    travel: useSharedValue(0),
    finger: useSharedValue(0),
    startScroll: useSharedValue(0),
    rowHeight: useSharedValue(64),
  };

  const count = items.length;

  // Once React has drawn the dropped order, the rows drop their offsets.
  useLayoutEffect(() => {
    if (!dropped.current) return;
    dropped.current = false;
    drag.from.set(-1);
    drag.offset.set(0);
  }, [items, drag.from, drag.offset]);

  // Near an edge, scroll the page and carry the dragged row along with it, only while dragging.
  const edgeScroll = useFrameCallback(() => {
    if (drag.from.value === -1) return;
    const finger = drag.finger.value;

    const speed =
      finger > screen - EDGE
        ? MAX_SPEED * Math.min(1, (finger - (screen - EDGE)) / EDGE)
        : finger < EDGE * 1.5
          ? -MAX_SPEED * Math.min(1, (EDGE * 1.5 - finger) / EDGE)
          : 0;

    if (speed === 0) return;
    scrollTo(scrollRef, 0, Math.max(0, Math.min(maxScroll.value, scroll.value + speed)), false);
    drag.offset.value = drag.travel.value + scroll.value - drag.startScroll.value;
    drag.to.value = slotFor(drag.from.value, drag.offset.value, drag.rowHeight.value, count);
  }, false);

  return items.map((item, index) => (
    <ReorderRow
      key={keyOf(item)}
      index={index}
      count={count}
      drag={drag}
      scroll={scroll}
      label={labelOf(item)}
      render={(grip) => renderItem(item, grip)}
      onLift={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        edgeScroll.setActive(true);
      }}
      onRelease={() => edgeScroll.setActive(false)}
      onRemove={() => onRemove(item)}
      onDrop={(from, to) => {
        if (from === to) {
          drag.from.set(-1);
          drag.offset.set(0);

          return;
        }

        dropped.current = true;
        onMove(from, to);
      }}
      onLayout={
        index === 0 ? (event) => drag.rowHeight.set(event.nativeEvent.layout.height) : undefined
      }
    />
  ));
}

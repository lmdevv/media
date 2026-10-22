/**
 * The upcoming queue with drag to reorder (B03) and remove (B04). Holding a row's handle lifts a
 * copy of the row that follows the finger, the rows between slide apart to show where it will
 * land, and the list scrolls while the finger rests near an edge. The drag runs on the UI thread;
 * only the drop crosses into React, which shows the new order at once and sends one move.
 */
import { FlashList } from "@shopify/flash-list";
import type { FlashListRef } from "@shopify/flash-list";
import * as Haptics from "expo-haptics";
import { Equal, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Row } from "@/components/ui/row";
import { dropIndex, edgeScroll, moved, shiftOf } from "@/lib/reorder";
import type { QueueItem } from "@/player";

/** How long the rows take to slide out of the lifted row's way. */
const SHIFT_MS = 150;

/** The drag in progress, shared between the cells and the lifted copy. */
interface Drag {
  /** The lifted row's index, or -1. */
  readonly from: SharedValue<number>;
  /** Where it would drop. */
  readonly to: SharedValue<number>;
  /** How far the finger moved since the lift. */
  readonly offset: SharedValue<number>;
  readonly scrollY: SharedValue<number>;
  /** The scroll position at the lift. */
  readonly startScroll: SharedValue<number>;
  readonly rowHeight: SharedValue<number>;
  readonly headerHeight: SharedValue<number>;
  readonly count: SharedValue<number>;
}

/** What a row can do. */
interface RowActions {
  readonly onLift: (index: number) => void;
  readonly onDrop: (from: number, to: number) => void;
  readonly onJump: (item: QueueItem) => void;
  readonly onRemove: (item: QueueItem) => void;
}

/** The two-line handle Paper draws; holding it lifts the row. */
function Handle({
  index,
  title,
  drag,
  actions,
}: {
  readonly index: number;
  readonly title: string;
  readonly drag: Drag;
  readonly actions: RowActions;
}) {
  const pan = usePanGesture({
    minDistance: 0,
    shouldCancelWhenOutside: false,
    onBegin: () => {
      "worklet";
      drag.from.value = index;
      drag.to.value = index;
      drag.offset.value = 0;
      drag.startScroll.value = drag.scrollY.value;
      scheduleOnRN(actions.onLift, index);
    },
    onUpdate: (event) => {
      "worklet";
      drag.offset.value = event.translationY;
    },
    onFinalize: () => {
      "worklet";

      if (drag.from.value < 0) return;
      const from = drag.from.value;
      const to = drag.to.value;
      scheduleOnRN(actions.onDrop, from, to);
    },
  });

  return (
    <GestureDetector gesture={pan}>
      <View
        className="size-hit-target items-center justify-center"
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Reorder ${title}`}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => {
          const step = event.nativeEvent.actionName === "increment" ? 1 : -1;
          actions.onDrop(index, Math.max(0, index + step));
        }}
      >
        <Icon icon={Equal} size="inline" />
      </View>
    </GestureDetector>
  );
}

/** A queue row: remove (in edit mode), art, title, artist, and the handle. */
function QueueRow({
  item,
  index,
  editing,
  drag,
  actions,
}: {
  readonly item: QueueItem;
  readonly index: number;
  readonly editing: boolean;
  readonly drag: Drag | null;
  readonly actions: RowActions;
}) {
  return (
    <View className="flex-row items-center gap-2 bg-canvas">
      {editing ? (
        <IconButton
          icon={X}
          label={`Remove ${item.title}`}
          size="inline"
          className="-mx-3"
          onPress={() => {
            actions.onRemove(item);
          }}
        />
      ) : null}
      <View className="min-w-0 flex-1">
        <Row
          title={item.title}
          subtitle={item.artist}
          leading={{ kind: "art", url: item.artUrl, recyclingKey: item.itemId }}
          onPress={
            editing
              ? undefined
              : () => {
                  actions.onJump(item);
                }
          }
          trailing={
            drag === null ? (
              <View className="size-hit-target items-center justify-center">
                <Icon icon={Equal} size="inline" />
              </View>
            ) : (
              <Handle index={index} title={item.title} drag={drag} actions={actions} />
            )
          }
        />
      </View>
    </View>
  );
}

/** A cell that slides out of the lifted row's way, and hides while it is the one lifted. */
function Cell({
  index,
  drag,
  children,
}: {
  readonly index: number;
  readonly drag: Drag;
  readonly children: ReactNode;
}) {
  const style = useAnimatedStyle(() => {
    const from = drag.from.value;

    if (from < 0) return { opacity: 1, transform: [{ translateY: 0 }] };

    const shift = shiftOf(index, from, drag.to.value) * drag.rowHeight.value;

    return {
      opacity: index === from ? 0 : 1,
      transform: [{ translateY: withTiming(shift, { duration: SHIFT_MS }) }],
    };
  });

  return (
    <Animated.View
      style={style}
      onLayout={(event) => {
        if (index === 0) drag.rowHeight.value = event.nativeEvent.layout.height;
      }}
    >
      {children}
    </Animated.View>
  );
}

/** Props for `ReorderList`. */
export interface ReorderListProps {
  /** The songs after the current one that the listener queued. */
  readonly items: ReadonlyArray<QueueItem>;
  /** B04: rows show a remove button and don't jump when tapped. */
  readonly editing: boolean;
  /** Moves the song at `from` to `to`, both indexes into `items`. */
  readonly onMove: (item: QueueItem, to: number) => void;
  readonly onJump: (item: QueueItem) => void;
  readonly onRemove: (item: QueueItem) => void;
  /** Above the rows: the current song, the modes, and the section title. */
  readonly header: ReactNode;
  /** Under the rows: what autoplay added. */
  readonly footer?: ReactNode;
}

/** The queue list with its header and footer. */
export function ReorderList({
  items,
  editing,
  onMove,
  onJump,
  onRemove,
  header,
  footer,
}: ReorderListProps) {
  const list = useRef<FlashListRef<QueueItem>>(null);
  // The order a drop showed, until the server's queue changes.

  const [order, setOrder] = useState<{
    readonly source: string;
    readonly items: ReadonlyArray<QueueItem>;
  } | null>(null);

  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [lifted, setLifted] = useState<number | null>(null);
  const [listHeight, setListHeight] = useState(0);

  const source = items.map((item) => item.itemId).join(",");
  const ordered = order?.source === source ? order.items : items;
  const shown = ordered.filter((item) => !removed.has(item.itemId));

  const drag: Drag = {
    from: useSharedValue(-1),
    to: useSharedValue(-1),
    offset: useSharedValue(0),
    scrollY: useSharedValue(0),
    startScroll: useSharedValue(0),
    rowHeight: useSharedValue(0),
    headerHeight: useSharedValue(0),
    count: useSharedValue(shown.length),
  };

  useEffect(() => {
    drag.count.value = shown.length;
  }, [drag.count, shown.length]);

  // Where the lifted row would land follows the finger and the list's own scrolling.
  useAnimatedReaction(
    () =>
      drag.from.value < 0
        ? -1
        : dropIndex(
            drag.from.value,
            drag.offset.value + drag.scrollY.value - drag.startScroll.value,
            drag.rowHeight.value,
            drag.count.value,
          ),
    (next, previous) => {
      if (next < 0 || next === previous) return;
      drag.to.value = next;

      if (previous !== null && previous >= 0) scheduleOnRN(Haptics.selectionAsync);
    },
  );

  // While a row is lifted and the finger rests near an edge, the list scrolls under it.
  useEffect(() => {
    if (lifted === null) return undefined;

    const timer = setInterval(() => {
      const top =
        drag.headerHeight.value +
        drag.from.value * drag.rowHeight.value -
        drag.startScroll.value +
        drag.offset.value;

      const speed = edgeScroll(top + drag.rowHeight.value / 2, listHeight);

      if (speed !== 0) {
        list.current?.scrollToOffset({
          offset: Math.max(0, drag.scrollY.value + speed),
          animated: false,
        });
      }
    }, 16);

    return () => {
      clearInterval(timer);
    };
  }, [lifted, listHeight, drag]);

  const actions: RowActions = {
    onLift: (index) => {
      setLifted(index);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    },
    onDrop: (from, to) => {
      drag.from.value = -1;
      drag.to.value = -1;
      setLifted(null);
      const item = shown[from];

      if (item === undefined || from === to) return;
      setOrder({ source, items: moved(shown, from, to) });
      onMove(item, to);
    },
    onJump,
    onRemove: (item) => {
      setRemoved((current) => new Set([...current, item.itemId]));
      onRemove(item);
    },
  };

  const ghost = useAnimatedStyle(() => ({
    opacity: drag.from.value < 0 ? 0 : 1,
    transform: [
      {
        // The copy stays under the finger: where the row sat at the lift, plus the finger's travel.
        translateY:
          drag.headerHeight.value +
          Math.max(0, drag.from.value) * drag.rowHeight.value -
          drag.startScroll.value +
          drag.offset.value,
      },
    ],
  }));

  const liftedItem = lifted === null ? undefined : shown[lifted];

  return (
    <View
      className="flex-1"
      onLayout={(event) => {
        setListHeight(event.nativeEvent.layout.height);
      }}
    >
      <FlashList
        ref={list}
        data={shown}
        extraData={editing}
        keyExtractor={(item) => item.itemId}
        scrollEnabled={lifted === null}
        onScroll={(event) => {
          drag.scrollY.value = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        contentContainerClassName="px-mobile-edge pb-row"
        ListHeaderComponent={
          <View
            onLayout={(event) => {
              drag.headerHeight.value = event.nativeEvent.layout.height;
            }}
          >
            {header}
          </View>
        }
        ListFooterComponent={footer === undefined ? null : <>{footer}</>}
        renderItem={({ item, index }) => (
          <Cell index={index} drag={drag}>
            <QueueRow item={item} index={index} editing={editing} drag={drag} actions={actions} />
          </Cell>
        )}
      />
      <Animated.View
        pointerEvents="none"
        style={ghost}
        className="absolute top-0 right-0 left-0 px-mobile-edge"
      >
        {liftedItem === undefined ? null : (
          <View className="rounded-md bg-canvas shadow-lg">
            <QueueRow
              item={liftedItem}
              index={-1}
              editing={editing}
              drag={null}
              actions={actions}
            />
          </View>
        )}
      </Animated.View>
    </View>
  );
}

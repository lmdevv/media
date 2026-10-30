/**
 * The queue inside Now Playing (B03, B04, H06), as Apple Music shows it: shuffle, repeat, and
 * autoplay as three pills, then "Playing Next" with the songs queued after the current one, which
 * drag to reorder and swipe left to remove. Songs autoplay added follow under "Continue Playing",
 * as on the web. The rows fade out above the controls. The iPad's panel (B1) shows the same list
 * under Paper's smaller heading, closer to its edges.
 */
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import type { LucideIcon } from "lucide-react-native";
import { Infinity as Endless, Repeat, Repeat1, Shuffle } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { REPEAT_LABELS } from "@/lib/playback-format";
import { usePlayer, usePlayerActions } from "@/player";
import type { QueueItem } from "@/player";

import { EdgeFade } from "./edge-fade";
import { QUEUE_EDGE, QueueLine, ReorderList } from "./reorder-list";
import type { PanelPlace } from "./reorder-list";

/**
 * What differs by place: how far the list reaches past its parent's margin, the Clear sheet's route,
 * and the mode pills' shape, which in the panel matches its tab switch.
 */
const PLACES = {
  player: { bleed: "bleed-page", clear: "/player/clear-queue", pill: "h-ios-36 rounded-full" },
  panel: { bleed: "-mx-4", clear: "/clear-queue", pill: "h-8 rounded-md" },
} as const;

/** A mode pill: the text color with an inverse glyph when on, a faint wash of it when off. */
function ModePill({
  icon,
  label,
  on,
  place,
  onPress,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly on: boolean;
  readonly place: PanelPlace;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      className={`flex-1 items-center justify-center active:opacity-70 ${PLACES[place].pill} ${on ? "bg-text" : "bg-text/8"}`}
    >
      <Icon icon={icon} tone={on ? "inverse" : "default"} size="inline" />
    </Pressable>
  );
}

/** Shuffle, repeat, and autoplay. */
export function ModePills({ place = "player" }: { readonly place?: PanelPlace }) {
  const { shuffle, repeat, autoplay } = usePlayer();
  const actions = usePlayerActions();

  return (
    <View className="flex-row gap-2 py-2">
      <ModePill
        icon={Shuffle}
        label="Shuffle"
        on={shuffle}
        place={place}
        onPress={() => void actions.setShuffle(!shuffle)}
      />
      <ModePill
        icon={repeat === "one" ? Repeat1 : Repeat}
        label={REPEAT_LABELS[repeat]}
        on={repeat !== "off"}
        place={place}
        onPress={() => void actions.cycleRepeat()}
      />
      <ModePill
        icon={Endless}
        label="Autoplay"
        on={autoplay}
        place={place}
        onPress={() => void actions.setAutoplay(!autoplay)}
      />
    </View>
  );
}

/** "Playing Next" and Clear, or what an empty queue says. */
function PlayingNext({ empty, place }: { readonly empty: boolean; readonly place: PanelPlace }) {
  const panel = place === "panel";

  return (
    <View className={QUEUE_EDGE[place]}>
      <View className={`flex-row items-center justify-between ${panel ? "h-ios-28" : "pt-4 pb-1"}`}>
        <Text
          variant={panel ? "mono" : "subheading"}
          tone={panel ? "muted" : "default"}
          accessibilityRole="header"
        >
          {panel ? "UP NEXT" : "Playing Next"}
        </Text>
        {empty ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear queue"
            hitSlop={12}
            onPress={() => router.push(PLACES[place].clear)}
            className="active:opacity-60"
          >
            <Text variant={panel ? "secondary" : "secondaryStrong"} tone="accent">
              Clear
            </Text>
          </Pressable>
        )}
      </View>
      {empty ? (
        <Text tone="muted" className="py-2">
          Nothing is queued after this song.
        </Text>
      ) : null}
    </View>
  );
}

/** What autoplay added after the queued songs; tapping one plays it. */
function ContinuePlaying({
  items,
  place,
}: {
  readonly items: ReadonlyArray<QueueItem>;
  readonly place: PanelPlace;
}) {
  const { jump } = usePlayerActions();

  if (items.length === 0) return null;

  return (
    <View>
      <View className={`pt-4 pb-1 ${QUEUE_EDGE[place]}`}>
        <Text variant="subheading" accessibilityRole="header">
          Continue Playing
        </Text>
        <Text variant="secondary" tone="muted">
          Autoplay · similar in your library
        </Text>
      </View>
      {items.map((item) => (
        <Pressable
          key={item.itemId}
          accessibilityRole="button"
          accessibilityLabel={`${item.title}, ${item.artist}`}
          accessibilityHint="Plays this song"
          onPress={() => void jump(item.itemId)}
          className={`min-h-row-touch flex-row items-center gap-3 py-2 active:opacity-60 ${QUEUE_EDGE[place]}`}
        >
          <QueueLine item={item} timed={place === "panel"} />
        </Pressable>
      ))}
    </View>
  );
}

/** The songs after the current one, on `background`, the sheet's color. */
export function QueueList({
  background,
  place = "player",
}: {
  readonly background: string;
  readonly place?: PanelPlace;
}) {
  const { queue, index, autoplay } = usePlayer();
  const actions = usePlayerActions();

  const upcoming = queue.slice(index + 1);
  const queued = upcoming.filter((item) => !item.autoplay);
  const added = upcoming.filter((item) => item.autoplay);

  return (
    // The rows run to the sheet's edges, so a swiped row's Remove reaches the side of the screen.
    <View className={`min-h-0 flex-1 overflow-hidden ${PLACES[place].bleed}`}>
      <ReorderList
        items={queued}
        background={background}
        place={place}
        onMove={(item, to) => void actions.moveInQueue(item.itemId, index + 1 + to)}
        onJump={(item) => void actions.jump(item.itemId)}
        onRemove={(item) => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void actions.removeFromQueue(item.itemId);
        }}
        header={<PlayingNext empty={queued.length === 0} place={place} />}
        footer={autoplay ? <ContinuePlaying items={added} place={place} /> : undefined}
      />
      <EdgeFade edge="bottom" background={background} />
    </View>
  );
}

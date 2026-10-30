/**
 * The queue inside Now Playing (B03, B04, H06), as Apple Music shows it: shuffle, repeat, and
 * autoplay as three pills, then "Playing Next" with the songs queued after the current one, which
 * drag to reorder and swipe left to remove. Songs autoplay added follow under "Continue Playing",
 * as on the web. The rows fade out above the controls.
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
import { QueueLine, ReorderList } from "./reorder-list";

/** A mode pill: the text color with an inverse glyph when on, a faint wash of it when off. */
function ModePill({
  icon,
  label,
  on,
  onPress,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly on: boolean;
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
      className={`h-ios-36 flex-1 items-center justify-center rounded-full active:opacity-70 ${on ? "bg-text" : "bg-text/8"}`}
    >
      <Icon icon={icon} tone={on ? "inverse" : "default"} size="inline" />
    </Pressable>
  );
}

/** Shuffle, repeat, and autoplay. */
export function ModePills() {
  const { shuffle, repeat, autoplay } = usePlayer();
  const actions = usePlayerActions();

  return (
    <View className="flex-row gap-2 py-2">
      <ModePill
        icon={Shuffle}
        label="Shuffle"
        on={shuffle}
        onPress={() => void actions.setShuffle(!shuffle)}
      />
      <ModePill
        icon={repeat === "one" ? Repeat1 : Repeat}
        label={REPEAT_LABELS[repeat]}
        on={repeat !== "off"}
        onPress={() => void actions.cycleRepeat()}
      />
      <ModePill
        icon={Endless}
        label="Autoplay"
        on={autoplay}
        onPress={() => void actions.setAutoplay(!autoplay)}
      />
    </View>
  );
}

/** "Playing Next" and Clear, or what an empty queue says. */
function PlayingNext({ empty }: { readonly empty: boolean }) {
  return (
    <View className="px-page">
      <View className="flex-row items-center justify-between pt-4 pb-1">
        <Text variant="subheading" accessibilityRole="header">
          Playing Next
        </Text>
        {empty ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear queue"
            hitSlop={12}
            onPress={() => router.push("/player/clear-queue")}
            className="active:opacity-60"
          >
            <Text variant="secondaryStrong" tone="accent">
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
function ContinuePlaying({ items }: { readonly items: ReadonlyArray<QueueItem> }) {
  const { jump } = usePlayerActions();

  if (items.length === 0) return null;

  return (
    <View>
      <View className="px-page pt-4 pb-1">
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
          className="min-h-row-touch flex-row items-center gap-3 px-page py-2 active:opacity-60"
        >
          <QueueLine item={item} />
        </Pressable>
      ))}
    </View>
  );
}

/** The songs after the current one, on `background`, the sheet's color. */
export function QueueList({ background }: { readonly background: string }) {
  const { queue, index, autoplay } = usePlayer();
  const actions = usePlayerActions();

  const upcoming = queue.slice(index + 1);
  const queued = upcoming.filter((item) => !item.autoplay);
  const added = upcoming.filter((item) => item.autoplay);

  return (
    // The rows run to the sheet's edges, so a swiped row's Remove reaches the side of the screen.
    <View className="bleed-page min-h-0 flex-1 overflow-hidden">
      <ReorderList
        items={queued}
        background={background}
        onMove={(item, to) => void actions.moveInQueue(item.itemId, index + 1 + to)}
        onJump={(item) => void actions.jump(item.itemId)}
        onRemove={(item) => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void actions.removeFromQueue(item.itemId);
        }}
        header={<PlayingNext empty={queued.length === 0} />}
        footer={autoplay ? <ContinuePlaying items={added} /> : undefined}
      />
      <EdgeFade edge="bottom" background={background} />
    </View>
  );
}

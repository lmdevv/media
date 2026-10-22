/**
 * Playing next (B03, H06) and its edit mode (B04): the current song, the shuffle, repeat, and
 * autoplay chips, then the songs queued after it, which drag to reorder and, in edit mode, remove.
 * Songs autoplay added follow under their own heading, as on the web.
 */
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Check, ListOrdered, Pause, Play } from "lucide-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { NavBar } from "@/components/ui/nav-bar";
import { Row } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { playsOn } from "@/lib/playback-format";
import { usePlayer, usePlayerActions } from "@/player";
import type { QueueItem } from "@/player";

import { MenuButton } from "./menu-button";
import { ReorderList } from "./reorder-list";

const REPEAT_CHIP = { off: "Repeat", all: "Repeat", one: "Repeat one" } as const;

/** A mode chip: on is the text color with inverse label, off sits on the surface. */
function ModeChip({
  label,
  on,
  onPress,
}: {
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
      className={`rounded-full px-4 py-2 active:opacity-70 ${on ? "bg-text" : "bg-surface"}`}
    >
      <Text variant="secondaryStrong" tone={on ? "inverse" : "default"}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The current song, the mode chips, and the "Next in queue" heading. */
function Header({ current, empty }: { readonly current: QueueItem; readonly empty: boolean }) {
  const { status, shuffle, repeat, autoplay } = usePlayer();
  const actions = usePlayerActions();
  const playing = playsOn(status);

  return (
    <View>
      <Row
        title={current.title}
        subtitle={current.artist}
        active
        leading={{ kind: "art", url: current.artUrl, recyclingKey: current.itemId }}
        accessibilityLabel={`Now playing: ${current.title}, ${current.artist}`}
        trailing={<Icon icon={playing ? Pause : Play} tone="muted" size="inline" filled />}
      />
      <View className="flex-row gap-2 py-3">
        <ModeChip label="Shuffle" on={shuffle} onPress={() => void actions.setShuffle(!shuffle)} />
        <ModeChip
          label={REPEAT_CHIP[repeat]}
          on={repeat !== "off"}
          onPress={() => void actions.cycleRepeat()}
        />
        <ModeChip
          label="Autoplay"
          on={autoplay}
          onPress={() => void actions.setAutoplay(!autoplay)}
        />
      </View>
      <SectionHeader
        title="Next in queue"
        action={
          empty
            ? undefined
            : { kind: "link", label: "Clear", onPress: () => router.push("/player/clear-queue") }
        }
      />
      {empty ? (
        <Text tone="muted" className="pb-2">
          Nothing is queued after this song.
        </Text>
      ) : null}
    </View>
  );
}

/** What autoplay added after the queued songs; tapping one plays it. */
function AutoplaySection({ items }: { readonly items: ReadonlyArray<QueueItem> }) {
  const { jump } = usePlayerActions();

  if (items.length === 0) return null;

  return (
    <View>
      <SectionHeader title="Autoplay" />
      {items.map((item) => (
        <Row
          key={item.itemId}
          title={item.title}
          subtitle={item.artist}
          leading={{ kind: "art", url: item.artUrl, recyclingKey: item.itemId }}
          onPress={() => void jump(item.itemId)}
        />
      ))}
    </View>
  );
}

/** The Playing next screen. */
export function QueueScreen() {
  const { queue, index, autoplay } = usePlayer();
  const actions = usePlayerActions();
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState(false);

  const current = queue[index];
  const upcoming = queue.slice(index + 1);
  const queued = upcoming.filter((item) => !item.autoplay);
  const added = upcoming.filter((item) => item.autoplay);

  const trailing = editing ? (
    <IconButton
      icon={Check}
      label="Done"
      onPress={() => {
        setEditing(false);
      }}
    />
  ) : (
    <MenuButton
      label="Queue actions"
      items={[
        {
          title: "Edit queue",
          icon: "pencil",
          onPress: () => {
            setEditing(true);
          },
        },
        {
          title: "Clear queue",
          icon: "trash",
          destructive: true,
          onPress: () => {
            router.push("/player/clear-queue");
          },
        },
      ]}
    />
  );

  return (
    <View className="flex-1 bg-canvas" style={{ paddingBottom: insets.bottom }}>
      {/* The queue sits in the Now Playing sheet, which starts below the status bar. */}
      <SafeAreaInsetsContext value={{ ...insets, top: 0 }}>
        {editing ? (
          <NavBar
            title="Edit queue"
            trailing={trailing}
            onBack={() => {
              setEditing(false);
            }}
          />
        ) : (
          <NavBar title="Playing next" {...(current === undefined ? {} : { trailing })} />
        )}
      </SafeAreaInsetsContext>
      {current === undefined ? (
        <View className="px-mobile-edge">
          <EmptyState
            icon={ListOrdered}
            title={"Nothing\nqueued."}
            body={"Play a song and what comes\nnext shows up here."}
          />
        </View>
      ) : (
        <ReorderList
          items={queued}
          editing={editing}
          onMove={(item, to) => void actions.moveInQueue(item.itemId, index + 1 + to)}
          onJump={(item) => void actions.jump(item.itemId)}
          onRemove={(item) => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            void actions.removeFromQueue(item.itemId);
          }}
          header={
            editing ? (
              <Text variant="callout" tone="muted">
                Drag to reorder. Tap a minus to remove.
              </Text>
            ) : (
              <Header current={current} empty={queued.length === 0} />
            )
          }
          footer={editing || !autoplay ? undefined : <AutoplaySection items={added} />}
        />
      )}
    </View>
  );
}

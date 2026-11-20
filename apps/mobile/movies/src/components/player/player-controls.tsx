import { Button as MenuButton, Host, Menu, RNHostView } from "@expo/ui/swift-ui";
import { onDisappear } from "@expo/ui/swift-ui/modifiers";
import { VideoAirPlayButton } from "expo-video";
import { LinearGradient } from "expo-linear-gradient";
import {
  Captions,
  ChevronLeft,
  Ellipsis,
  LockKeyhole,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  Sun,
  Volume2,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useThemeColor } from "@/lib/theme-color";
import type { ScrubTile } from "@/lib/player/scrubbing";

import { Scrubber } from "./scrubber";
import { SleepTimerMenu } from "./sleep-timer";
import type { SleepTimerButton } from "./sleep-timer";
import { Spinner } from "./spinner";
import type { Transport } from "./transport";
import { VerticalSlider } from "./vertical-slider";

/** How far the skip buttons move, in seconds. */
const SKIP_SECONDS = 10;

/** One item of the More menu. */
export interface MoreItem {
  readonly label: string;
  /** An SF Symbol, as the native menu draws it. */
  readonly systemImage:
    | "list.bullet.rectangle"
    | "list.number"
    | "dial.medium"
    | "speedometer"
    | "person.2";
  readonly onPress: () => void;
}

/** Props for `PlayerControls`. */
export interface PlayerControlsProps {
  readonly title: string;
  /** The episode under a show's name, such as `S1, E2 · Gran Dillama`. */
  readonly detail: string | null;
  /** The centre: a spinner while the video loads, else play or pause. */
  readonly transport: Transport;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly rateLabel: string;
  readonly brightness: number;
  readonly volume: number;
  readonly more: ReadonlyArray<MoreItem>;
  /** The sleep timer's button; null hides it, as in a group session. */
  readonly sleepTimer: SleepTimerButton | null;
  readonly tileAt: (seconds: number) => ScrubTile | null;
  readonly onClose: () => void;
  readonly onTogglePlay: () => void;
  readonly onSeek: (seconds: number) => void;
  readonly onLock: () => void;
  readonly onSpeed: () => void;
  readonly onAudioSubtitles: () => void;
  /** Plays the next episode; `null` hides the button, as for a movie or a show's last episode. */
  readonly onNext: (() => void) | null;
  readonly onBrightness: (value: number) => void;
  readonly onVolume: (value: number) => void;
  /** The viewer is using the controls; keep them up. `true` holds them while a drag lasts. */
  readonly onInteract: (holding?: boolean) => void;
  /** A tap away from any control: hide them. */
  readonly onDismiss: () => void;
  /**
   * Replaces the transport with a lock line, such as `Only Lucía can pause or seek`, for a group
   * session's member who may not control it. While the video loads, the spinner shows instead.
   */
  readonly locked?: string | undefined;
}

/** A round 44pt button on the controls' glass. */
function RoundButton({
  icon,
  label,
  onPress,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="size-11 items-center justify-center rounded-pill bg-dark-surface-raised/80 active:opacity-70"
    >
      <Icon icon={icon} tone="onMedia" />
    </Pressable>
  );
}

function SkipButton({
  direction,
  onPress,
}: {
  readonly direction: "back" | "forward";
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={
        direction === "back"
          ? `Back ${String(SKIP_SECONDS)} seconds`
          : `Forward ${String(SKIP_SECONDS)} seconds`
      }
      className="items-center active:opacity-60"
    >
      <Icon icon={direction === "back" ? RotateCcw : RotateCw} tone="onMedia" size="control" />
      <Text variant="metaSemibold" tone="onMedia">
        {String(SKIP_SECONDS)}
      </Text>
    </Pressable>
  );
}

/**
 * The spinner in a box the size of the play button. A note such as `Reconnecting…` hangs below the
 * box without moving what sits beside it.
 */
export function TransportSpinner({ note }: { readonly note: string | null }) {
  return (
    <View className="size-13 items-center justify-center" pointerEvents="none">
      <Spinner size="transport" />
      {note === null ? null : (
        <Text
          variant="status"
          tone="onMedia"
          numberOfLines={1}
          className="absolute top-full mt-4 w-60 text-center"
        >
          {note}
        </Text>
      )}
    </View>
  );
}

/**
 * The centre of the controls: one box the size of the play button, holding the spinner while the
 * video loads and play or pause once it can play, so the swap moves nothing.
 */
function TransportSlot({
  transport,
  onTogglePlay,
}: {
  readonly transport: Transport;
  readonly onTogglePlay: () => void;
}) {
  if (transport.kind === "loading") return <TransportSpinner note={transport.note} />;

  return (
    <Pressable
      onPress={onTogglePlay}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={transport.playing ? "Pause" : "Play"}
      className="size-13 items-center justify-center active:opacity-60"
    >
      <Icon icon={transport.playing ? Pause : Play} tone="onMedia" size="transport" filled />
    </Pressable>
  );
}

/** A text action along the bottom, with an optional glyph. */
function BarAction({
  icon,
  label,
  onPress,
}: {
  readonly icon?: LucideIcon;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="h-9 shrink flex-row items-center gap-2 active:opacity-60"
    >
      {icon === undefined ? null : <Icon icon={icon} tone="onMedia" size="row" />}
      <Text variant="labelStrong" tone="onMedia" numberOfLines={1} className="shrink">
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * More: the native menu behind the round ellipsis button. Touching it holds the controls up, as the
 * menu closes with them; picking an item or dismissing the menu (its items disappear) lets them go.
 */
function MoreMenu({
  items,
  onOpen,
  onRelease,
}: {
  readonly items: ReadonlyArray<MoreItem>;
  readonly onOpen: () => void;
  readonly onRelease: () => void;
}) {
  return (
    <View onTouchStart={onOpen}>
      <Host matchContents>
        <Menu
          label={
            <RNHostView matchContents>
              <View
                accessible
                accessibilityRole="button"
                accessibilityLabel="More"
                className="size-9 items-center justify-center rounded-pill bg-dark-surface-raised/80"
              >
                <Icon icon={Ellipsis} tone="onMedia" />
              </View>
            </RNHostView>
          }
        >
          {items.map((item) => (
            <MenuButton
              key={item.label}
              label={item.label}
              systemImage={item.systemImage}
              modifiers={[onDisappear(onRelease)]}
              onPress={() => {
                onRelease();
                item.onPress();
              }}
            />
          ))}
        </Menu>
      </Host>
    </View>
  );
}

/**
 * The margins from the screen's edges: 32pt for the top bar and the side sliders, 64pt for the
 * scrubber and the bottom row. On a phone whose notch or home indicator takes more, the safe area
 * wins, so controls sit at these margins or just clear of the hardware, whichever is further in.
 */
const PLAYER_MARGINS = { bar: 32, slider: 22, row: 64 } as const;

/** The horizontal padding that puts a row `margin` points in, or inside the safe area. */
const useMargin = (margin: number) => {
  const insets = useSafeAreaInsets();

  return {
    paddingLeft: Math.max(margin, insets.left),
    paddingRight: Math.max(margin, insets.right),
  };
};

/** The controls over the video. */
export function PlayerControls(props: PlayerControlsProps) {
  const scrim = useThemeColor("--color-scrim");
  const bottom = useThemeColor("--color-dark-bg");
  const white = useThemeColor("--color-dark-text");
  const { onInteract } = props;
  const insets = useSafeAreaInsets();
  const bar = useMargin(PLAYER_MARGINS.bar);
  const slider = useMargin(PLAYER_MARGINS.slider);
  const row = useMargin(PLAYER_MARGINS.row);

  return (
    <View className="absolute inset-0" pointerEvents="box-none">
      <LinearGradient
        colors={[scrim, "transparent", bottom]}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <Pressable
        className="absolute inset-0"
        onPress={props.onDismiss}
        accessibilityLabel="Hide controls"
      />
      <View className="flex-1" style={{ paddingBottom: insets.bottom }} pointerEvents="box-none">
        <View className="h-17 flex-row items-center gap-4" style={bar} pointerEvents="box-none">
          <RoundButton icon={ChevronLeft} label="Close" onPress={props.onClose} />
          <View className="flex-1">
            <Text variant="navTitle" tone="onMedia" numberOfLines={1}>
              {props.title}
            </Text>
            {props.detail === null ? null : (
              <Text variant="meta" tone="darkMuted" numberOfLines={1}>
                {props.detail}
              </Text>
            )}
          </View>
          {props.sleepTimer === null ? null : (
            <SleepTimerMenu
              timer={props.sleepTimer}
              onOpen={() => onInteract(true)}
              onRelease={() => onInteract(false)}
            />
          )}
          <View className="size-11 items-center justify-center overflow-hidden rounded-pill bg-dark-surface-raised/80">
            <VideoAirPlayButton
              tint={white}
              activeTint={white}
              prioritizeVideoDevices
              style={StyleSheet.absoluteFill}
              accessibilityLabel="AirPlay"
              onBeginPresentingRoutes={() => onInteract(true)}
              onEndPresentingRoutes={() => onInteract(false)}
            />
          </View>
          <RoundButton icon={LockKeyhole} label="Lock Controls" onPress={props.onLock} />
        </View>

        <View
          className="flex-1 flex-row items-center justify-between"
          style={slider}
          pointerEvents="box-none"
        >
          <VerticalSlider
            icon={Sun}
            label="Brightness"
            value={props.brightness}
            onChange={props.onBrightness}
            onInteract={() => onInteract()}
          />
          {props.locked === undefined ? (
            <View className="flex-row items-center gap-16" pointerEvents="box-none">
              <SkipButton
                direction="back"
                onPress={() => props.onSeek(props.positionSeconds - SKIP_SECONDS)}
              />
              <TransportSlot transport={props.transport} onTogglePlay={props.onTogglePlay} />
              <SkipButton
                direction="forward"
                onPress={() => props.onSeek(props.positionSeconds + SKIP_SECONDS)}
              />
            </View>
          ) : props.transport.kind === "loading" ? (
            <TransportSpinner note={props.transport.note} />
          ) : (
            <View className="h-9 flex-row items-center gap-2 rounded-pill bg-dark-surface-raised/80 px-3.5">
              <Icon icon={LockKeyhole} tone="onMedia" size="inline" />
              <Text variant="labelStrong" tone="onMedia">
                {props.locked}
              </Text>
            </View>
          )}
          <VerticalSlider
            icon={Volume2}
            label="Volume"
            value={props.volume}
            onChange={props.onVolume}
            onInteract={() => onInteract()}
          />
        </View>

        <View style={row} pointerEvents="box-none">
          <Scrubber
            positionSeconds={props.positionSeconds}
            durationSeconds={props.durationSeconds}
            tileAt={props.tileAt}
            onScrubbing={(scrubbing) => onInteract(scrubbing)}
            onSeek={props.onSeek}
          />
        </View>
        <View className="flex-row items-center pt-1 pb-3" style={row} pointerEvents="box-none">
          <View className="flex-1" pointerEvents="none" />
          <View className="min-w-0 shrink flex-row items-center gap-8" pointerEvents="box-none">
            <BarAction label={props.rateLabel} onPress={props.onSpeed} />
            <BarAction icon={Captions} label="Audio & Subtitles" onPress={props.onAudioSubtitles} />
            {props.onNext === null ? null : (
              <BarAction icon={SkipForward} label="Next Episode" onPress={props.onNext} />
            )}
          </View>
          <View className="flex-1 flex-row justify-end" pointerEvents="box-none">
            {props.more.length === 0 ? null : (
              <MoreMenu
                items={props.more}
                onOpen={() => onInteract(true)}
                onRelease={() => onInteract(false)}
              />
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

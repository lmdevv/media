/**
 * The Now Playing panel in the iPad's frame (page 26): a rounded pane beside the content in a wide
 * window on its side (B1, B2), or a sheet above the player bar otherwise (B3). It holds the song,
 * its like and actions, and a switch between the queue, the lyrics, and About, on the player's tint.
 */
import { ChevronRight, Disc3, MicVocal, PanelRight, Settings2 } from "lucide-react-native";
import { lyricsButton } from "@music/player/lyrics";
import { router } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { useState } from "react";
import type { ReactNode } from "react";
import Animated, {
  SlideInDown,
  SlideInRight,
  SlideOutDown,
  SlideOutRight,
} from "react-native-reanimated";

import { AudioDetailRows } from "@/components/playback/audio-details";
import { EdgeFade } from "@/components/playback/edge-fade";
import { LikeButton } from "@/components/playback/like-button";
import { MoreButton, PanelBody } from "@/components/playback/now-playing";
import { useArtTint } from "@/components/playback/use-art-tint";
import { Artwork } from "@/components/ui/artwork";
import { IconButton } from "@/components/ui/icon-button";
import { Icon } from "@/components/ui/icon";
import { Row } from "@/components/ui/row";
import { Text } from "@/components/ui/text";
import type { InspectorTab } from "@/lib/inspector";
import { useThemeColor, useThemeLength } from "@/lib/theme-color";
import { useWindowLayout } from "@/lib/window-layout";
import type { NowPlaying } from "@/player";

import type { Inspector } from "./use-inspector";

const TABS: ReadonlyArray<{ readonly tab: InspectorTab; readonly label: string }> = [
  { tab: "queue", label: "Up next" },
  { tab: "lyrics", label: "Lyrics" },
  { tab: "about", label: "About" },
];

/** Paper's segmented switch; Lyrics dims for a song with none. */
function TabSwitch({ inspector }: { readonly inspector: Inspector }) {
  return (
    <View accessibilityRole="tablist" className="shrink-0 flex-row rounded-md bg-text/8 p-ios-2">
      {TABS.map(({ tab, label }) => {
        const selected = inspector.tab === tab;
        const disabled = tab === "lyrics" && lyricsButton(inspector.offer, false).disabled;

        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => {
              inspector.pick(tab);
            }}
            className={`h-8 flex-1 items-center justify-center rounded-sm ${selected ? "bg-bg shadow-sm shadow-glass-shadow" : ""} ${disabled ? "opacity-disabled" : "active:opacity-60"}`}
          >
            <Text variant={selected ? "secondaryStrong" : "secondaryMedium"} numberOfLines={1}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** "Now Playing", or `children` where the title needs their room, and the button that hides the panel. */
function Header({
  onHide,
  children,
}: {
  readonly onHide: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <View className="h-hit-target shrink-0 flex-row items-center justify-between">
      {children ?? (
        <Text variant="bodyStrong" accessibilityRole="header">
          Now Playing
        </Text>
      )}
      <IconButton
        icon={PanelRight}
        label="Hide Now Playing"
        tone="muted"
        size="side"
        onPress={onHide}
      />
    </View>
  );
}

/** The song's title, over its artist and album. */
function SongText({ song }: { readonly song: NowPlaying }) {
  return (
    <View className="min-w-0 flex-1">
      <Text variant="panelHeading" numberOfLines={1}>
        {song.title}
      </Text>
      <Text variant="callout" tone="muted" numberOfLines={1}>
        {`${song.artist} · ${song.album}`}
      </Text>
    </View>
  );
}

/** The heart, and the song's actions, which Paper doesn't draw but the panel must keep reachable. */
function SongActions({ song }: { readonly song: NowPlaying }) {
  return (
    <View className="flex-row items-center">
      <LikeButton trackId={song.trackId} liked={song.liked} size="side" />
      <MoreButton song={song} size="side" />
    </View>
  );
}

/** About: where the song comes from, then what the sheet says of its audio. */
function About({ song, background }: { readonly song: NowPlaying; readonly background: string }) {
  const { albumId, artistId } = song;

  return (
    <View className="min-h-0 flex-1">
      <ScrollView showsVerticalScrollIndicator={false} contentContainerClassName="pb-6">
        {albumId === undefined ? null : (
          <Row
            title={song.album}
            subtitle="Album"
            leading={{ kind: "icon", icon: Disc3 }}
            trailing={<Icon icon={ChevronRight} tone="muted" size="inline" />}
            onPress={() => {
              router.push({ pathname: "/album/[id]", params: { id: albumId } });
            }}
          />
        )}
        {artistId === undefined ? null : (
          <Row
            title={song.artist}
            subtitle="Artist"
            leading={{ kind: "icon", icon: MicVocal }}
            trailing={<Icon icon={ChevronRight} tone="muted" size="inline" />}
            onPress={() => {
              router.push({ pathname: "/artist/[id]", params: { id: artistId } });
            }}
          />
        )}
        <AudioDetailRows song={song} />
        <Row
          title="Playback settings"
          leading={{ kind: "icon", icon: Settings2 }}
          trailing={<Icon icon={ChevronRight} tone="muted" size="inline" />}
          onPress={() => {
            router.push("/settings/playback");
          }}
        />
      </ScrollView>
      <EdgeFade edge="bottom" background={background} />
    </View>
  );
}

/** The tab's body. */
function Body({
  song,
  inspector,
  background,
}: {
  readonly song: NowPlaying;
  readonly inspector: Inspector;
  readonly background: string;
}) {
  const { tab, lyrics, covered } = inspector;

  if (tab === "about") return <About song={song} background={background} />;

  return (
    <PanelBody
      panel={tab}
      song={song}
      lyrics={lyrics}
      background={background}
      place="panel"
      paused={covered}
    />
  );
}

/** The player's color behind the panel: the tint of the cover, once it has been read. */
const usePanelColor = (song: NowPlaying): string => {
  const tint = useArtTint(song.artUrl);
  const player = useThemeColor("--color-player");

  return tint ?? player;
};

/**
 * The pane beside the content (B1, B2). Paper's 320pt cover leaves the body too little room in a
 * short window, so there the cover drops to a row beside the song.
 */
export function InspectorPane({
  song,
  inspector,
}: {
  readonly song: NowPlaying;
  readonly inspector: Inspector;
}) {
  const background = usePanelColor(song);
  const fullCover = useThemeLength("--spacing-ios-780");
  const [height, setHeight] = useState<number | null>(null);
  const short = height !== null && height < fullCover;

  return (
    <Animated.View
      entering={SlideInRight.duration(220)}
      exiting={SlideOutRight.duration(160)}
      className="mr-2 w-ios-360 shrink-0 overflow-hidden rounded-mobile-card"
      style={{ backgroundColor: background }}
    >
      <View
        className="flex-1 gap-4 px-4 pt-2 pb-4"
        onLayout={(event) => {
          setHeight(event.nativeEvent.layout.height);
        }}
      >
        <Header onHide={inspector.hide} />
        {short ? null : (
          <View className="shrink-0 items-center">
            <Artwork
              url={song.artUrl}
              recyclingKey={song.trackId}
              className="size-ios-320 rounded-lg"
            />
          </View>
        )}
        <View className="shrink-0 flex-row items-center gap-3">
          {short ? (
            <Artwork
              url={song.artUrl}
              recyclingKey={song.trackId}
              className="size-16 shrink-0 rounded-md"
            />
          ) : null}
          <SongText song={song} />
          <SongActions song={song} />
        </View>
        <TabSwitch inspector={inspector} />
        <View className="min-h-0 flex-1">
          <Body song={song} inspector={inspector} background={background} />
        </View>
      </View>
    </Animated.View>
  );
}

/**
 * The sheet above the player bar (B3), in the frame's flow so the page above stays scrollable to
 * its end. Paper draws it at the 13-inch iPad's width; a `tablet` window keeps the body's 320pt by
 * shrinking the cover, or in narrow Split View dropping it, and gives the title the header's
 * label's place to the song's buttons.
 */
export function InspectorSheet({
  song,
  inspector,
}: {
  readonly song: NowPlaying;
  readonly inspector: Inspector;
}) {
  const background = usePanelColor(song);
  const { width, widthClass } = useWindowLayout();
  const room = useThemeLength("--spacing-ios-720");
  const wide = widthClass === "wide";

  return (
    <Animated.View
      entering={SlideInDown.duration(220)}
      exiting={SlideOutDown.duration(160)}
      className="shrink-0 px-2 pb-2"
    >
      <View
        className="rounded-mobile-card shadow-lg shadow-glass-shadow"
        style={{ backgroundColor: background }}
      >
        <View className="h-ios-200 box-content flex-row gap-6 overflow-hidden px-4 py-6">
          {width < room ? null : (
            <Artwork
              url={song.artUrl}
              recyclingKey={song.trackId}
              className={`shrink-0 rounded-lg ${wide ? "size-ios-200" : "size-ios-120"}`}
            />
          )}
          <View className={`min-w-0 justify-between gap-3 ${wide ? "flex-1" : "w-ios-208"}`}>
            <Header onHide={inspector.hide}>{wide ? null : <SongActions song={song} />}</Header>
            <View className="flex-row items-center">
              <SongText song={song} />
              {wide ? <SongActions song={song} /> : null}
            </View>
            <TabSwitch inspector={inspector} />
          </View>
          <View className={`min-h-0 min-w-0 ${wide ? "w-ios-320" : "flex-1"}`}>
            <Body song={song} inspector={inspector} background={background} />
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

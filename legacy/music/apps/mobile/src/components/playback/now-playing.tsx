import { lyricsButton, lyricsOffer } from "@music/player/lyrics";
import type { LyricsAnswer, LyricsOffer } from "@music/player/lyrics";
import { useRead } from "@music/sdk/react";
import * as Haptics from "expo-haptics";
import { router, useNavigation } from "expo-router";
import {
  Airplay,
  Ellipsis,
  List,
  MessageSquareQuote,
  Music,
  Smartphone,
  Users,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { ActivityIndicator, Pressable, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { openSongActions } from "@/components/browse/rows";
import { LikeButton } from "@/components/playback/like-button";
import { Artwork } from "@/components/ui/artwork";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { CLOSED, layoutOf, partsOf, pressedPanel } from "@/lib/now-playing-layout";
import type { NowPlayingLayout, NowPlayingParts, Panel, StageView } from "@/lib/now-playing-layout";
import type { SheetSong } from "@/lib/song-sheet";
import { useThemeColor, useThemeLength } from "@/lib/theme-color";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { useWindowLayout } from "@/lib/window-layout";
import { usePlayer } from "@/player";
import type { NowPlaying, PlayerRole } from "@/player";

import { LyricsPanel } from "./lyrics";
import { NOW_PLAYING_PRESENTATION } from "./now-playing-presentation";
import { ModePills, QueueList } from "./queue";
import type { PanelPlace } from "./reorder-list";
import { Scrubber } from "./scrubber";
import { Transport, VolumeRow } from "./transport";
import { useArtTint } from "./use-art-tint";
import { useSongLyrics } from "./use-song-lyrics";

const close = () => {
  router.back();
};

const leaveTo = (go: () => void) => {
  router.dismiss();
  go();
};

const sheetSongOf = (song: NowPlaying): SheetSong | null =>
  song.artistId === undefined || song.albumId === undefined
    ? null
    : {
        id: song.trackId,
        title: song.title,
        artist: song.artist,
        artistId: song.artistId,
        album: song.album,
        albumId: song.albumId,
        liked: song.liked,
      };

const MORPH = { duration: 450, dampingRatio: 0.9 } as const;

const STAGE_TOP = "--spacing-2";

const STAGE_GAP = "--spacing-6";

interface Box {
  readonly width: number;
  readonly height: number;
}

type CoverLimit = "--spacing-ios-326" | "--container-dialog" | "--spacing-ios-520";

const COLUMN: Readonly<
  Record<NowPlayingLayout, { readonly cover: CoverLimit; readonly width: string }>
> = {
  sheet: { cover: "--spacing-ios-326", width: "" },
  column: { cover: "--container-dialog", width: "max-w-dialog" },
  split: { cover: "--spacing-ios-520", width: "max-w-ios-520" },
};

type LyricsChipLook = "glyph" | "spinner" | null;

const LYRICS_CHIP: Readonly<Record<LyricsOffer, LyricsChipLook>> = {
  ready: "glyph",
  failed: "glyph",
  loading: "spinner",
  none: null,
  instrumental: null,
};

type CoverTap = "close" | "lyrics" | "none";

const COVER_TAP: Readonly<
  Record<
    CoverTap,
    {
      readonly role: "button" | "image";
      readonly label: (album: string, offer: LyricsOffer) => string;
      readonly hint?: string;
    }
  >
> = {
  close: { role: "button", label: () => "Show the cover" },
  lyrics: {
    role: "button",
    label: (_album, offer) => lyricsButton(offer, false).label,
    hint: "Shows the lyrics",
  },
  none: { role: "image", label: (album) => `Cover of ${album}` },
};

const coverTap = (open: boolean, chip: LyricsChipLook): CoverTap => {
  if (open) return "close";

  return chip === null ? "none" : "lyrics";
};

const DISMISS = { share: 0.25, drift: 100, flick: 800, slop: 12 } as const;

function DragToClose({
  drag,
  enabled = true,
  children,
}: {
  readonly drag: SharedValue<number> | null;
  readonly enabled?: boolean;
  readonly children: ReactElement;
}) {
  const { height } = useWindowDimensions();

  const pan = usePanGesture({
    enabled: drag !== null && enabled,
    activeOffsetY: DISMISS.slop,
    failOffsetX: [-DISMISS.slop, DISMISS.slop],
    onUpdate: (event) => {
      "worklet";

      if (drag !== null) drag.value = Math.max(0, event.translationY);
    },
    onDeactivate: (event) => {
      "worklet";

      if (drag === null) return;
      const past = event.translationY > height * DISMISS.share && event.velocityY > -DISMISS.drift;

      if (!event.canceled && (past || event.velocityY > DISMISS.flick)) {
        scheduleOnRN(close);
      } else {
        drag.value = withSpring(0, MORPH);
      }
    },
  });

  if (drag === null) return children;

  return <GestureDetector gesture={pan}>{children}</GestureDetector>;
}

function Handle({ onClose }: { readonly onClose: (() => void) | null }) {
  const bar = <View className="h-1 w-row rounded-full bg-text-muted opacity-muted" />;

  return (
    <View className="h-row-touch items-center justify-center px-page">
      {onClose === null ? (
        <View className="size-hit-target items-center justify-center" accessible={false}>
          {bar}
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close Now Playing"
          onPress={onClose}
          className="size-hit-target items-center justify-center active:opacity-60"
        >
          {bar}
        </Pressable>
      )}
    </View>
  );
}

/**
 * The ellipsis beside the heart: Song actions, or Audio details for a Jam song kept private,
 * which has no song actions.
 */
export function MoreButton({
  song,
  size = "nav",
}: {
  readonly song: NowPlaying;
  readonly size?: "nav" | "side";
}) {
  const sheetSong = sheetSongOf(song);

  return (
    <IconButton
      icon={Ellipsis}
      label={sheetSong === null ? "Audio details" : "More"}
      size={size}
      onPress={() => {
        if (sheetSong === null) {
          router.push("/audio");
        } else {
          openSongActions(sheetSong);
        }
      }}
    />
  );
}

function ArtistLink({
  song,
  variant,
}: {
  readonly song: NowPlaying;
  readonly variant: "body" | "secondary";
}) {
  const { artistId } = song;

  if (artistId === undefined) {
    return (
      <Text variant={variant} tone="muted" numberOfLines={1}>
        {song.artist}
      </Text>
    );
  }

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={song.artist}
      accessibilityHint="Opens the artist"
      onPress={() => {
        leaveTo(() => {
          router.push({ pathname: "/artist/[id]", params: { id: artistId } });
        });
      }}
      className="self-start active:opacity-60"
    >
      <Text variant={variant} tone="muted" numberOfLines={1}>
        {song.artist}
      </Text>
    </Pressable>
  );
}

function TitleRow({ song }: { readonly song: NowPlaying }) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="min-w-0 flex-1 gap-1">
        <Text variant="songTitle" numberOfLines={1} accessibilityRole="header">
          {song.title}
        </Text>
        <ArtistLink song={song} variant="body" />
      </View>
      <View className="flex-row items-center">
        <LikeButton trackId={song.trackId} liked={song.liked} />
        <MoreButton song={song} />
      </View>
    </View>
  );
}

function SongRow({ song }: { readonly song: NowPlaying }) {
  return (
    <View className="min-h-16 flex-row items-center gap-3 py-2">
      <View className="size-16 shrink-0" />
      <View className="min-w-0 flex-1">
        <Text variant="bodyStrong" numberOfLines={1} accessibilityRole="header">
          {song.title}
        </Text>
        <ArtistLink song={song} variant="secondary" />
      </View>
      <View className="flex-row items-center">
        <LikeButton trackId={song.trackId} liked={song.liked} />
        <MoreButton song={song} />
      </View>
    </View>
  );
}

/**
 * A panel's body, in place under the song's row, in the side pane, or in the iPad's panel: the queue
 * under its mode pills (B03), or the song's lyrics (B12), fresh for each song.
 */
export function PanelBody({
  panel,
  song,
  lyrics,
  background,
  place = "player",
  paused = false,
}: {
  readonly panel: Panel;
  readonly song: NowPlaying;
  readonly lyrics: LyricsAnswer;
  readonly background: string;
  readonly place?: PanelPlace;
  /** Whether something covers the body, so its lyrics stop following playback. */
  readonly paused?: boolean;
}) {
  if (panel === "lyrics") {
    return (
      <LyricsPanel
        key={song.trackId}
        lyrics={lyrics}
        background={background}
        place={place}
        paused={paused}
      />
    );
  }

  return (
    <>
      <ModePills place={place} />
      <QueueList background={background} place={place} />
    </>
  );
}

function DeviceButton({ role }: { readonly role: PlayerRole }) {
  const remote = role.kind === "remote";
  const label = remote ? `Playing on ${role.device.name}` : `This ${DEVICE_FAMILY}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Chooses where the music plays"
      onPress={() => router.push("/player/devices")}
      className="min-h-hit-target min-w-0 shrink flex-row items-center gap-2 px-2 active:opacity-60"
    >
      <Icon icon={remote ? Airplay : Smartphone} size="inline" />
      <Text variant="secondaryStrong" tone={remote ? "accent" : "muted"} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function JamButton() {
  const jam = useRead("jam.get", {});
  const inJam = jam !== undefined && jam !== null;

  return (
    <IconButton
      icon={Users}
      label={inJam ? "Your Jam" : "Start a Jam"}
      tone={inJam ? "accent" : "default"}
      onPress={() => {
        if (inJam) {
          leaveTo(() => {
            router.push("/jam");
          });
        } else {
          router.push("/jam/start");
        }
      }}
    />
  );
}

function LyricsButton({
  offer,
  selected,
  onPress,
}: {
  readonly offer: LyricsOffer;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const { label, disabled, loading } = lyricsButton(offer, false);

  return (
    <IconButton
      icon={MessageSquareQuote}
      label={label}
      loading={loading}
      disabled={disabled}
      accessibilityState={{ selected, disabled }}
      className={`${selected ? "bg-text/10" : ""} ${disabled ? "opacity-disabled" : ""}`}
      onPress={onPress}
    />
  );
}

function ActionRow({
  role,
  selected,
  lyrics,
  onPanel,
}: {
  readonly role: PlayerRole;
  readonly selected: Panel | null;
  readonly lyrics: LyricsOffer | null;
  readonly onPanel: (panel: Panel) => void;
}) {
  const queueOpen = selected === "queue";

  return (
    <View className="flex-row items-center justify-between pt-4">
      <View className="w-ios-88 flex-row items-center">
        <JamButton />
      </View>
      <DeviceButton role={role} />
      <View className="w-ios-88 flex-row items-center justify-end">
        {lyrics === null ? null : (
          <LyricsButton
            offer={lyrics}
            selected={selected === "lyrics"}
            onPress={() => {
              onPanel("lyrics");
            }}
          />
        )}
        <IconButton
          icon={List}
          label="Queue"
          accessibilityState={{ selected: queueOpen }}
          className={queueOpen ? "bg-text/10" : ""}
          onPress={() => {
            onPanel("queue");
          }}
        />
      </View>
    </View>
  );
}

const useFailureSheet = (failed: boolean, error: string | null, itemId: string | undefined) => {
  const navigation = useNavigation();
  const shown = useRef<string | null>(null);
  const key = failed ? `${itemId ?? ""}:${error ?? ""}` : null;

  useEffect(() => {
    if (key === null) {
      shown.current = null;

      return;
    }

    if (shown.current === key || !navigation.isFocused()) return;
    shown.current = key;
    router.push("/player/unavailable");
  }, [key, navigation]);
};

function NothingPlaying({ drag }: { readonly drag: SharedValue<number> | null }) {
  const empty = (
    <EmptyState
      icon={Music}
      title={"Something good\nis waiting."}
      body={"Choose a song from your collection.\nYour listening session starts here."}
      primary={
        <Button
          label="Browse library"
          onPress={() => {
            leaveTo(() => {
              router.navigate("/(app)/(tabs)/(library)");
            });
          }}
        />
      }
    />
  );

  if (drag === null) return <View className="px-page">{empty}</View>;

  return (
    <DragToClose drag={drag}>
      <View className="flex-1 items-center justify-center px-page pb-row">
        <View className="w-full max-w-dialog">{empty}</View>
      </View>
    </DragToClose>
  );
}

function LyricsChip({
  loading,
  progress,
}: {
  readonly loading: boolean;
  readonly progress: SharedValue<number>;
}) {
  const white = useThemeColor("--color-dark-text");

  const fade = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.3], [1, 0], Extrapolation.CLAMP),
  }));

  return (
    <Animated.View
      style={fade}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute right-3 bottom-3 size-8 items-center justify-center rounded-full bg-scrim/55 tablet:right-4 tablet:bottom-4"
    >
      {loading ? (
        <ActivityIndicator size="small" color={white} />
      ) : (
        <Icon icon={MessageSquareQuote} tone="overArt" size="meta" />
      )}
    </Animated.View>
  );
}

function Stage({
  song,
  view,
  folds,
  lyricsFrom,
  largest: largestToken,
  titleHeight,
  lyrics,
  progress,
  background,
  onTitleHeight,
  onOpenLyrics,
  onClose,
}: {
  readonly song: NowPlaying;
  readonly view: StageView;
  readonly folds: boolean;
  readonly lyricsFrom: NowPlayingParts["lyricsFrom"];
  readonly largest: CoverLimit;
  readonly titleHeight: number;
  readonly lyrics: LyricsAnswer;
  readonly progress: SharedValue<number>;
  readonly background: string;
  readonly onTitleHeight: (height: number) => void;
  readonly onOpenLyrics: () => void;
  readonly onClose: () => void;
}) {
  const { open } = view;
  const offer = lyricsOffer(lyrics);
  const chip = lyricsFrom === "cover" ? LYRICS_CHIP[offer] : null;
  const tap = COVER_TAP[coverTap(open, chip)];

  const [live, setLive] = useState<Box | null>(null);

  const [fold, setFold] = useState<{ readonly folds: boolean; readonly held: Box | null }>({
    folds,
    held: null,
  });

  if (fold.folds !== folds) setFold({ folds, held: folds ? live : null });

  const { held } = fold;

  const box =
    folds && held !== null && live !== null ? { width: live.width, height: held.height } : live;

  const largest = useThemeLength(largestToken);
  const small = useThemeLength("--spacing-16");
  const top = useThemeLength(STAGE_TOP);
  const gap = useThemeLength(STAGE_GAP);
  const coverRadius = useThemeLength("--radius-mobile-card");
  const rowRadius = useThemeLength("--radius-md");

  const width = box?.width ?? 0;

  const size = Math.max(
    small,
    Math.min(width, largest, (box?.height ?? 0) - titleHeight - top - gap),
  );

  const left = (width - size) / 2;

  const measured = box !== null;

  const cover = useAnimatedStyle(() => {
    const at = progress.value;
    const scale = 1 + (small / size - 1) * at;

    return {
      opacity: measured ? 1 : 0,
      left,
      top,
      width: size,
      height: size,
      transformOrigin: "top left",
      borderRadius: (coverRadius + (rowRadius - coverRadius) * at) / scale,
      transform: [{ translateX: -left * at }, { scale }],
    };
  }, [progress, measured, left, top, size, small, coverRadius, rowRadius]);

  const title = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4], [1, 0], Extrapolation.CLAMP),
    transform: [{ translateY: -12 * progress.value }],
  }));

  const panel = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.35, 1], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: 24 * (1 - progress.value) }],
  }));

  return (
    <View
      className="flex-1"
      onLayout={(event) => {
        const { width: nextWidth, height } = event.nativeEvent.layout;

        if (folds && held !== null && held.width === nextWidth) {
          if (live?.width !== held.width || live.height !== held.height) setLive(held);

          return;
        }

        setLive({ width: nextWidth, height });
      }}
    >
      <Animated.View
        style={title}
        pointerEvents={open ? "none" : "box-none"}
        accessibilityElementsHidden={open}
        className="absolute inset-x-0 bottom-0"
        onLayout={(event) => {
          onTitleHeight(event.nativeEvent.layout.height);
        }}
      >
        <TitleRow song={song} />
      </Animated.View>
      {view.panel === null ? null : (
        <Animated.View
          style={panel}
          pointerEvents={open ? "box-none" : "none"}
          accessibilityElementsHidden={!open}
          className="absolute inset-0"
        >
          <SongRow song={song} />
          <PanelBody panel={view.panel} song={song} lyrics={lyrics} background={background} />
        </Animated.View>
      )}
      <Animated.View style={cover} className="absolute overflow-hidden">
        <Pressable
          accessibilityRole={tap.role}
          accessibilityLabel={tap.label(song.album, offer)}
          accessibilityHint={tap.hint}
          accessibilityState={{ busy: !open && chip === "spinner" }}
          disabled={tap.role === "image"}
          onPress={open ? onClose : onOpenLyrics}
          className="size-full"
        >
          <Artwork url={song.artUrl} className="size-full" />
        </Pressable>
        {chip === null ? null : <LyricsChip loading={chip === "spinner"} progress={progress} />}
      </Animated.View>
    </View>
  );
}

function Controls({
  folds,
  folded,
  progress,
  onHeight,
  children,
}: {
  readonly folds: boolean;
  readonly folded: boolean;
  readonly progress: SharedValue<number>;
  readonly onHeight?: (height: number) => void;
  readonly children: ReactNode;
}) {
  const rowsHeight = useSharedValue(0);
  const tighten = useThemeLength("--spacing-2");

  const heights = useRef({ scrubber: 0, transport: 0, rows: 0 });

  const measure = (part: keyof typeof heights.current, height: number) => {
    heights.current[part] = height;
    const { scrubber, transport, rows } = heights.current;

    if (scrubber > 0 && transport > 0 && rows > 0) onHeight?.(scrubber + transport + rows);
  };

  const transport = useAnimatedStyle(() => {
    const shut = folds ? progress.value : 0;

    return { marginVertical: -tighten * shut };
  }, [progress, folds, tighten]);

  const rows = useAnimatedStyle(() => {
    const shut = folds ? progress.value : 0;

    return {
      opacity: interpolate(shut, [0, 0.5], [1, 0], Extrapolation.CLAMP),
      marginBottom: -rowsHeight.value * shut,
    };
  }, [progress, folds]);

  return (
    <>
      <View
        onLayout={(event) => {
          measure("scrubber", event.nativeEvent.layout.height);
        }}
      >
        <Scrubber />
      </View>
      <Animated.View
        style={transport}
        onLayout={(event) => {
          measure("transport", event.nativeEvent.layout.height);
        }}
      >
        <Transport />
      </Animated.View>
      <Animated.View
        style={rows}
        pointerEvents={folds && folded ? "none" : "box-none"}
        accessibilityElementsHidden={folds && folded}
        onLayout={(event) => {
          rowsHeight.value = event.nativeEvent.layout.height;
          measure("rows", event.nativeEvent.layout.height);
        }}
      >
        {children}
      </Animated.View>
    </>
  );
}

function PlayerColumn({
  layout,
  song,
  parts,
  lyrics,
  progress,
  background,
  onOpenLyrics,
  onClose,
  children,
}: {
  readonly layout: NowPlayingLayout;
  readonly song: NowPlaying;
  readonly parts: NowPlayingParts;
  readonly lyrics: LyricsAnswer;
  readonly progress: SharedValue<number>;
  readonly background: string;
  readonly onOpenLyrics: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const [titleHeight, setTitleHeight] = useState(0);
  const [width, setWidth] = useState(0);
  const [controlsHeight, setControlsHeight] = useState(0);
  const column = COLUMN[layout];
  const largest = useThemeLength(column.cover);
  const top = useThemeLength(STAGE_TOP);
  const gap = useThemeLength(STAGE_GAP);

  const stage = (
    <Stage
      song={song}
      view={parts.stage}
      folds={parts.folds}
      lyricsFrom={parts.lyricsFrom}
      largest={column.cover}
      titleHeight={titleHeight}
      lyrics={lyrics}
      progress={progress}
      background={background}
      onTitleHeight={setTitleHeight}
      onOpenLyrics={onOpenLyrics}
      onClose={onClose}
    />
  );

  if (layout === "sheet") {
    return (
      <View className="flex-1 px-page pb-row">
        {stage}
        <Controls folds={parts.folds} folded={parts.stage.open} progress={progress}>
          {children}
        </Controls>
      </View>
    );
  }

  const measured = width > 0 && titleHeight > 0 && controlsHeight > 0;
  const tallest = Math.min(width, largest) + top + gap + titleHeight + controlsHeight;

  return (
    <View
      className={`w-full flex-1 ${column.width}`}
      style={measured ? { maxHeight: tallest } : undefined}
      onLayout={(event) => {
        setWidth(event.nativeEvent.layout.width);
      }}
    >
      {stage}
      <Controls
        folds={parts.folds}
        folded={parts.stage.open}
        progress={progress}
        onHeight={setControlsHeight}
      >
        {children}
      </Controls>
    </View>
  );
}

const SIDE_TOP: Readonly<Record<Panel, string>> = { queue: "pt-8", lyrics: "pt-2" };

function SidePane({
  panel,
  song,
  lyrics,
  background,
}: {
  readonly panel: Panel | null;
  readonly song: NowPlaying;
  readonly lyrics: LyricsAnswer;
  readonly background: string;
}) {
  return (
    <View className="min-h-0 w-ios-440 shrink-0">
      {panel === null ? null : (
        <View className={`min-h-0 flex-1 ${SIDE_TOP[panel]}`}>
          <PanelBody panel={panel} song={song} lyrics={lyrics} background={background} />
        </View>
      )}
    </View>
  );
}

function PlayerBody({
  layout,
  side,
  panelInPlace,
  drag,
  children,
}: {
  readonly layout: NowPlayingLayout;
  readonly side: ReactNode;
  readonly panelInPlace: boolean;
  readonly drag: SharedValue<number> | null;
  readonly children: ReactElement;
}) {
  if (layout === "sheet") return children;

  if (layout === "column") {
    return (
      <DragToClose drag={drag} enabled={!panelInPlace}>
        <View className="min-h-0 flex-1 items-center justify-center px-page pb-row">
          {children}
        </View>
      </DragToClose>
    );
  }

  return (
    <View className="min-h-0 flex-1 flex-row gap-12 px-page pb-row">
      <DragToClose drag={drag}>
        <View className="min-w-0 flex-1 items-center justify-center">{children}</View>
      </DragToClose>
      {side}
    </View>
  );
}

/** The Now Playing screen. */
export function NowPlayingScreen() {
  const { nowPlaying, role, status, error } = usePlayer();
  const tint = useArtTint(nowPlaying?.artUrl ?? null);
  const player = useThemeColor("--color-player");
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<StageView>(CLOSED);
  const progress = useSharedValue(0);
  const still = useSharedValue(0);
  const offset = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  const background = tint ?? player;
  const { widthClass, landscape } = useWindowLayout();
  const layout = layoutOf(NOW_PLAYING_PRESENTATION, widthClass, landscape);

  const { lyrics, offer, fallback } = useSongLyrics(nowPlaying?.trackId ?? null);
  const parts = partsOf(layout, view, offer, fallback);

  useFailureSheet(status === "failed" && role.kind !== "remote", error, nowPlaying?.itemId);

  const dragged = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));

  const windowed = NOW_PLAYING_PRESENTATION === "window";
  const drag = windowed ? offset : null;

  const unmountClosed = () => {
    setView((current) => (current.open ? current : CLOSED));
  };

  const show = (panel: Panel | null) => {
    void Haptics.selectionAsync();

    const instant = reduceMotion || layout === "split";

    if (panel !== null) {
      setView({ open: true, panel });

      if (!parts.morphs) progress.value = 0;
      progress.value = instant ? 1 : withSpring(1, MORPH);
    } else if (instant) {
      setView(CLOSED);
      progress.value = 0;
    } else {
      setView({ open: false, panel: view.panel });
      progress.value = withSpring(0, MORPH, (finished) => {
        if (finished === true) scheduleOnRN(unmountClosed);
      });
    }
  };

  return (
    <Animated.View
      className="flex-1"
      style={[
        {
          backgroundColor: background,
          paddingTop: windowed ? insets.top : 0,
          paddingBottom: insets.bottom,
        },
        dragged,
      ]}
      accessibilityViewIsModal={windowed}
      onAccessibilityEscape={windowed ? close : undefined}
    >
      <DragToClose drag={drag}>
        <Handle onClose={windowed ? close : null} />
      </DragToClose>
      {nowPlaying === null ? (
        <NothingPlaying drag={drag} />
      ) : (
        <PlayerBody
          layout={layout}
          panelInPlace={parts.stage.panel !== null}
          drag={drag}
          side={
            layout === "split" ? (
              <SidePane
                panel={parts.side}
                song={nowPlaying}
                lyrics={lyrics}
                background={background}
              />
            ) : null
          }
        >
          <PlayerColumn
            layout={layout}
            song={nowPlaying}
            parts={parts}
            lyrics={lyrics}
            progress={parts.morphs ? progress : still}
            background={background}
            onOpenLyrics={() => {
              show("lyrics");
            }}
            onClose={() => {
              show(null);
            }}
          >
            <VolumeRow />
            <ActionRow
              role={role}
              selected={parts.selected}
              lyrics={parts.lyricsFrom === "row" ? offer : null}
              onPanel={(panel) => {
                show(pressedPanel(layout, view, panel));
              }}
            />
          </PlayerColumn>
        </PlayerBody>
      )}
    </Animated.View>
  );
}

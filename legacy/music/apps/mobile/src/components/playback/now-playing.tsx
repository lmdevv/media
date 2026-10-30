/**
 * Now Playing (B01 local, B02 remote, H05 dark): a sheet over the tabs with the cover, the song,
 * the scrubber, the controls, the volume, and where the music plays. The background takes the
 * cover's color. Tapping the cover opens the lyrics (B12, H13) when the song has them, and the
 * queue button opens the queue (B03, H06), in place, as Apple Music does: the cover shrinks into
 * the corner of a row with the song's title, and the queue or the lyrics rise under it. The queue
 * keeps every control below it; the lyrics keep only the scrubber and the transport (B12–B14).
 * One of the two shows at a time. The person drags the sheet down to dismiss it (B11); the
 * sliders keep their own drags. With nothing queued it says so (G14).
 */
import type { TrackId } from "@music/commands/ids";
import { lyricsAnswer, lyricsButton, lyricsOffer, offlineLyrics } from "@music/player/lyrics";
import type { LyricsAnswer, LyricsOffer } from "@music/player/lyrics";
import { useRead, useReadSettled, useRun } from "@music/sdk/react";
import * as Haptics from "expo-haptics";
import { router, useNavigation } from "expo-router";
import {
  Airplay,
  Ellipsis,
  Heart,
  List,
  MessageSquareQuote,
  Music,
  Smartphone,
  Users,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import type { LayoutRectangle } from "react-native";
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
import { useSave } from "@/components/states/save-failure";
import { Artwork } from "@/components/ui/artwork";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { useDownloadedLyrics } from "@/downloads";
import type { SheetSong } from "@/lib/song-sheet";
import { useThemeColor, useThemeLength } from "@/lib/theme-color";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { usePlayer } from "@/player";
import type { NowPlaying, PlayerRole } from "@/player";
import { useServerReach } from "@/session/server-reach";

import { LyricsPanel } from "./lyrics";
import { ModePills, QueueList } from "./queue";
import { Scrubber } from "./scrubber";
import { Transport, VolumeRow } from "./transport";
import { useArtTint } from "./use-art-tint";

/** Leaves Now Playing for a page in the tabs underneath. */
const leaveTo = (go: () => void) => {
  router.dismiss();
  go();
};

/** The song as Song actions takes it; null for a Jam song kept private, with no album or artist. */
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

/** The cover's move between the full cover and the song's row: a soft spring with no bounce. */
const MORPH = { duration: 450, dampingRatio: 0.9 } as const;

/** What can open under the song's row in place of the cover. */
type Panel = "queue" | "lyrics";

/**
 * What the stage shows: the cover, or a panel under the song's row. Closed, `panel` is the one
 * still closing, mounted until the cover is back so it can animate, then null, so nothing in it
 * (the lyrics' frame loop) runs behind the cover.
 */
type StageView =
  | { readonly open: false; readonly panel: Panel | null }
  | { readonly open: true; readonly panel: Panel };

const CLOSED: StageView = { open: false, panel: null };

/**
 * The lyrics, open or closing, fold the volume and the bottom row away with the cover's morph,
 * leaving the scrubber and the transport (B12).
 */
const foldsOf = (view: StageView): boolean => view.panel === "lyrics";

/**
 * The chip on the cover's corner, which says the cover opens the lyrics: their `glyph`, a
 * `spinner` while they are looked up (B16), or none for a song with no lyrics or an instrumental
 * (B15), whose cover is only a picture. Looked up, the lyrics open too, on the song's own words
 * or "Looking for lyrics…"; failed, they open to say so.
 */
type LyricsChipLook = "glyph" | "spinner" | null;

const LYRICS_CHIP: Readonly<Record<LyricsOffer, LyricsChipLook>> = {
  ready: "glyph",
  failed: "glyph",
  loading: "spinner",
  none: null,
  instrumental: null,
};

/** What tapping the cover does: shows it again over an open panel, opens the lyrics, or nothing. */
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

/** The drag handle Paper draws in place of a close button. */
function Handle() {
  return (
    <View className="h-row-touch items-center justify-center px-page">
      <View className="size-hit-target items-center justify-center" accessible={false}>
        <View className="h-1 w-row rounded-full bg-text-muted opacity-muted" />
      </View>
    </View>
  );
}

/**
 * The ellipsis beside the heart: Song actions, or Audio details for a Jam song kept private,
 * which has no song actions.
 */
function MoreButton({ song }: { readonly song: NowPlaying }) {
  const sheetSong = sheetSongOf(song);

  return (
    <IconButton
      icon={Ellipsis}
      label={sheetSong === null ? "Audio details" : "More"}
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

/**
 * The heart: likes or unlikes the song at once, and settles on what the server keeps; a refusal
 * opens G13 to send it again.
 */
function LikeButton({ trackId, liked }: { readonly trackId: TrackId; readonly liked: boolean }) {
  const setLiked = useRun("likes.set");
  const save = useSave();

  const [pending, setPending] = useState<{
    readonly trackId: TrackId;
    readonly liked: boolean;
  } | null>(null);

  const shown = pending?.trackId === trackId ? pending.liked : liked;

  const toggle = async () => {
    const next = !shown;
    setPending({ trackId, liked: next });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    await save(
      async () => {
        await setLiked({ trackId, liked: next });
      },
      next ? "This song isn’t in your liked songs." : "This song is still in your liked songs.",
    );
    setPending(null);
  };

  return (
    <IconButton
      icon={Heart}
      label={shown ? "Unlike" : "Like"}
      tone={shown ? "accent" : "default"}
      filled={shown}
      accessibilityState={{ selected: shown }}
      onPress={() => void toggle()}
    />
  );
}

/** The artist under the title: a link to the artist, or plain for a song kept private. */
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

/** The song's title, its artist, the heart, and the ellipsis (B01). */
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

/**
 * The song as a row over the queue (B03) or the lyrics (B12): room for the 64pt cover, which the
 * morph moves into place, then title over artist, the heart, and the ellipsis.
 */
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

/** Where the music plays: this device in muted text, another device in the accent (B02). */
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

/**
 * Opens the Jam: Start a Jam (D01) over Now Playing when there is none, or the Jam itself over
 * the tabs, in the accent while one is on.
 */
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

/** Jam, the playing device, and the queue (B01). The queue sits on a faint wash while open. */
function ActionRow({
  role,
  queueOpen,
  onQueue,
}: {
  readonly role: PlayerRole;
  readonly queueOpen: boolean;
  readonly onQueue: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between pt-4">
      <View className="w-ios-88 flex-row items-center">
        <JamButton />
      </View>
      <DeviceButton role={role} />
      <View className="w-ios-88 flex-row items-center justify-end">
        <IconButton
          icon={List}
          label="Queue"
          accessibilityState={{ selected: queueOpen }}
          className={queueOpen ? "bg-text/10" : ""}
          onPress={onQueue}
        />
      </View>
    </View>
  );
}

/**
 * Presents the playback failure sheet (G06) once per failure, while Now Playing is on top. The
 * queue and the position stay as they were; the sheet says why.
 */
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

/** G14: the player opened with nothing queued. */
function NothingPlaying() {
  return (
    <View className="px-page">
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
    </View>
  );
}

/**
 * Paper's chip on the cover's corner, saying the cover opens the lyrics: their glyph, or a
 * spinner while they are looked up. Paper blurs behind it; the app has no blur, so it is the
 * scrim alone.
 */
function LyricsChip({
  loading,
  progress,
}: {
  readonly loading: boolean;
  readonly progress: SharedValue<number>;
}) {
  const white = useThemeColor("--color-dark-text");

  // Gone before the cover is small, so it never shows on the row's 64pt cover.
  const fade = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.3], [1, 0], Extrapolation.CLAMP),
  }));

  return (
    <Animated.View
      style={fade}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute right-3 bottom-3 size-8 items-center justify-center rounded-full bg-scrim/55"
    >
      {loading ? (
        <ActivityIndicator size="small" color={white} />
      ) : (
        <Icon icon={MessageSquareQuote} tone="overArt" size="meta" />
      )}
    </Animated.View>
  );
}

/**
 * Everything above the controls: the cover over the song's title, or the queue or the lyrics
 * under the song's row. `progress` runs from 0 (cover) to 1 (row), and one cover moves between
 * the two places, so it reads as the same picture shrinking into the row. Tapped, the cover opens
 * the lyrics (`onOpenLyrics`) when the song has them, or shows itself again over a panel.
 */
function Stage({
  song,
  view,
  lyrics,
  progress,
  background,
  onOpenLyrics,
  onClose,
}: {
  readonly song: NowPlaying;
  readonly view: StageView;
  readonly lyrics: LyricsAnswer;
  readonly progress: SharedValue<number>;
  readonly background: string;
  readonly onOpenLyrics: () => void;
  readonly onClose: () => void;
}) {
  const { open } = view;
  const folds = foldsOf(view);
  const offer = lyricsOffer(lyrics);
  const chip = LYRICS_CHIP[offer];
  const tap = COVER_TAP[coverTap(open, chip)];
  const [box, setBox] = useState<LayoutRectangle | null>(null);
  const [titleHeight, setTitleHeight] = useState(0);

  const largest = useThemeLength("--spacing-ios-326");
  const small = useThemeLength("--spacing-16");
  const top = useThemeLength("--spacing-2");
  const gap = useThemeLength("--spacing-6");
  const coverRadius = useThemeLength("--radius-mobile-card");
  const rowRadius = useThemeLength("--radius-md");

  // The cover fills the width up to Paper's 326pt, leaving room for the title under it. The
  // lyrics grow the stage as the controls under it go; the cover keeps the box it had, so the
  // morph starts where the cover is.
  const width = box?.width ?? 0;

  const size = Math.max(
    small,
    Math.min(width, largest, (box?.height ?? 0) - titleHeight - top - gap),
  );

  const left = (width - size) / 2;

  // The cover keeps its full size and scales from its top left corner, so the picture and its
  // frame move as one; the corner radius is set before scaling, so it lands on Paper's radius.
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
  }, [measured, left, top, size, small, coverRadius, rowRadius]);

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
        // Mounted with the lyrics already open, it takes the box it has, to show the cover at all.
        if (!folds || box === null) setBox(event.nativeEvent.layout);
      }}
    >
      <Animated.View
        style={title}
        pointerEvents={open ? "none" : "box-none"}
        accessibilityElementsHidden={open}
        className="absolute inset-x-0 bottom-0"
        onLayout={(event) => {
          setTitleHeight(event.nativeEvent.layout.height);
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
          {view.panel === "queue" ? (
            <>
              <ModePills />
              <QueueList background={background} />
            </>
          ) : (
            <LyricsPanel key={song.trackId} lyrics={lyrics} background={background} />
          )}
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

/**
 * The scrubber and the transport, then `children`, the rows the lyrics fold away (`folds`). They
 * fold with the cover's morph (`progress`), so the stage grows into their room as the cover
 * shrinks: the rows fade and slide out under the bottom edge, and the transport tightens to B12's
 * spacing. Folded, the rows take no touches.
 */
function Controls({
  folds,
  folded,
  progress,
  children,
}: {
  readonly folds: boolean;
  readonly folded: boolean;
  readonly progress: SharedValue<number>;
  readonly children: ReactNode;
}) {
  const rowsHeight = useSharedValue(0);
  const tighten = useThemeLength("--spacing-2");

  const transport = useAnimatedStyle(() => {
    const shut = folds ? progress.value : 0;

    return { marginVertical: -tighten * shut };
  }, [folds, tighten]);

  const rows = useAnimatedStyle(() => {
    const shut = folds ? progress.value : 0;

    return {
      opacity: interpolate(shut, [0, 0.5], [1, 0], Extrapolation.CLAMP),
      marginBottom: -rowsHeight.value * shut,
    };
  }, [folds]);

  return (
    <>
      <Scrubber />
      <Animated.View style={transport}>
        <Transport />
      </Animated.View>
      <Animated.View
        style={rows}
        pointerEvents={folds && folded ? "none" : "box-none"}
        accessibilityElementsHidden={folds && folded}
        onLayout={(event) => {
          rowsHeight.value = event.nativeEvent.layout.height;
        }}
      >
        {children}
      </Animated.View>
    </>
  );
}

/** The Now Playing screen. */
export function NowPlayingScreen() {
  const { nowPlaying, role, status, error, ownSession } = usePlayer();
  const tint = useArtTint(nowPlaying?.artUrl ?? null);
  const player = useThemeColor("--color-player");
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<StageView>(CLOSED);
  const progress = useSharedValue(0);
  const reduceMotion = useReducedMotion();
  const background = tint ?? player;

  // Read while Now Playing is up, for the cover's chip as much as for the lyrics. Settled, not
  // thrown: a failed read shows in the lyrics instead of taking Now Playing down.
  const served = lyricsAnswer(
    useReadSettled("lyrics.get", nowPlaying === null ? "skip" : { trackId: nowPlaying.trackId }),
  );

  // Kept lyrics are read from the vault only while the server can't be counted on.
  const reach = useServerReach();
  const offline = ownSession || reach !== "online";
  const held = useDownloadedLyrics(offline ? (nowPlaying?.trackId ?? null) : null);
  const lyrics = offline ? offlineLyrics(served, held) : served;

  useFailureSheet(status === "failed" && role.kind !== "remote", error, nowPlaying?.itemId);

  // Once the closing morph ends, unless a panel opened again meanwhile.
  const unmountClosed = () => {
    setView((current) => (current.open ? current : CLOSED));
  };

  const show = (panel: Panel | null) => {
    void Haptics.selectionAsync();

    if (panel !== null) {
      setView({ open: true, panel });
      progress.value = reduceMotion ? 1 : withSpring(1, MORPH);
    } else if (reduceMotion) {
      setView(CLOSED);
      progress.value = 0;
    } else {
      setView({ open: false, panel: view.panel });
      progress.value = withSpring(0, MORPH, (finished) => {
        if (finished === true) scheduleOnRN(unmountClosed);
      });
    }
  };

  const queueOpen = view.open && view.panel === "queue";

  return (
    <View className="flex-1" style={{ backgroundColor: background, paddingBottom: insets.bottom }}>
      <Handle />
      {nowPlaying === null ? (
        <NothingPlaying />
      ) : (
        <View className="flex-1 px-page pb-row">
          <Stage
            song={nowPlaying}
            view={view}
            lyrics={lyrics}
            progress={progress}
            background={background}
            onOpenLyrics={() => {
              show("lyrics");
            }}
            onClose={() => {
              show(null);
            }}
          />
          <Controls folds={foldsOf(view)} folded={view.open} progress={progress}>
            <VolumeRow />
            <ActionRow
              role={role}
              queueOpen={queueOpen}
              onQueue={() => {
                show(queueOpen ? null : "queue");
              }}
            />
          </Controls>
        </View>
      )}
    </View>
  );
}

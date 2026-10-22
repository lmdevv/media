/**
 * Now Playing (B01 local, B02 remote, H05 dark): a sheet over the tabs with the cover, the song,
 * the scrubber, the controls, the volume, and where the music plays. The background takes the
 * cover's color. The person drags the sheet down to dismiss it (B11); the sliders keep their own
 * drags. With nothing queued it says so (G14).
 */
import type { TrackId } from "@music/commands/ids";
import { useRead, useRun } from "@music/sdk/react";
import * as Haptics from "expo-haptics";
import { router, useNavigation } from "expo-router";
import { Heart, List, Music, Smartphone, Users, Airplay } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { openSongActions } from "@/components/browse/rows";
import { useSave } from "@/components/states/save-failure";
import { Artwork } from "@/components/ui/artwork";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import type { SheetSong } from "@/lib/song-sheet";
import { usePlayer } from "@/player";
import type { NowPlaying, PlayerRole } from "@/player";

import { MenuButton } from "./menu-button";
import type { MenuItem } from "./menu-button";
import { Scrubber } from "./scrubber";
import { Transport, VolumeRow } from "./transport";
import { useArtTint } from "./use-art-tint";

/** Leaves Now Playing for a page in the tabs underneath. */
const leaveTo = (go: () => void) => {
  router.dismiss();
  go();
};

/** The song as Song actions takes it; null for a Jam song kept private, which has nothing to open. */
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

const AUDIO_DETAILS: MenuItem = {
  title: "Audio details",
  icon: "waveform",
  onPress: () => {
    router.push("/player/audio");
  },
};

/** The drag handle Paper draws in place of a close button, and the ellipsis menu. */
function Header({ song }: { readonly song: NowPlaying | null }) {
  const sheetSong = song === null ? null : sheetSongOf(song);

  return (
    <View className="h-row-touch flex-row items-center justify-center px-mobile-edge">
      <View className="size-hit-target items-center justify-center" accessible={false}>
        <View className="h-1 w-row rounded-full bg-text-muted opacity-muted" />
      </View>
      {song === null ? null : (
        <View className="absolute right-mobile-edge">
          <MenuButton
            label="More"
            items={
              sheetSong === null
                ? [AUDIO_DETAILS]
                : [
                    {
                      title: "Song actions",
                      icon: "ellipsis.circle",
                      onPress: () => openSongActions(sheetSong),
                    },
                    AUDIO_DETAILS,
                  ]
            }
          />
        </View>
      )}
    </View>
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

/** The song's title, its artist (a link to the artist), and the heart. */
function TitleRow({ song }: { readonly song: NowPlaying }) {
  const { artistId } = song;

  return (
    <View className="flex-row items-center gap-3">
      <View className="min-w-0 flex-1 gap-1">
        <Text variant="songTitle" numberOfLines={1} accessibilityRole="header">
          {song.title}
        </Text>
        {artistId === undefined ? (
          <Text tone="muted" numberOfLines={1}>
            {song.artist}
          </Text>
        ) : (
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
            <Text tone="muted" numberOfLines={1}>
              {song.artist}
            </Text>
          </Pressable>
        )}
      </View>
      <LikeButton trackId={song.trackId} liked={song.liked} />
    </View>
  );
}

/** Where the music plays: this iPhone in muted text, another device in the accent (B02). */
function DeviceButton({ role }: { readonly role: PlayerRole }) {
  const remote = role.kind === "remote";
  const label = remote ? `Playing on ${role.device.name}` : "This iPhone";

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

/** Jam, the playing device, and the queue. */
function ActionRow({ role }: { readonly role: PlayerRole }) {
  return (
    <View className="flex-row items-center justify-between pt-4">
      <JamButton />
      <DeviceButton role={role} />
      <IconButton icon={List} label="Queue" onPress={() => router.push("/player/queue")} />
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
    <View className="px-mobile-edge">
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

/** The Now Playing screen. */
export function NowPlayingScreen() {
  const { nowPlaying, role, status, error } = usePlayer();
  const tint = useArtTint(nowPlaying?.artUrl ?? null);
  const insets = useSafeAreaInsets();

  useFailureSheet(status === "failed" && role.kind !== "remote", error, nowPlaying?.itemId);

  return (
    <View
      className="flex-1 bg-player"
      style={[tint === null ? null : { backgroundColor: tint }, { paddingBottom: insets.bottom }]}
    >
      <Header song={nowPlaying} />
      {nowPlaying === null ? (
        <NothingPlaying />
      ) : (
        <View className="flex-1 justify-between px-mobile-edge pb-row">
          <View className="items-center pt-2 pb-6">
            <Artwork
              url={nowPlaying.artUrl}
              className="aspect-square w-full max-w-ios-326 rounded-mobile-card"
            />
          </View>
          <View>
            <TitleRow song={nowPlaying} />
            <Scrubber />
            <Transport />
            <VolumeRow />
            <ActionRow role={role} />
          </View>
        </View>
      )}
    </View>
  );
}

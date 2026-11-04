import { errorMessage } from "@music/sdk/errors";
import { useReadOnce, useRun } from "@music/sdk/react";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import {
  AudioWaveform,
  Check,
  FastForward,
  Heart,
  Library,
  Link,
  List,
  Plus,
  Users,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { openAlbum, openArtist } from "@/components/browse/rows";
import { DownloadRow } from "@/components/downloads/download-row";
import { Icon } from "@/components/ui/icon";
import { Row, RowChevron } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { Text } from "@/components/ui/text";
import { mediaUrl } from "@/lib/media-url";
import { fileDetails } from "@/lib/playback-format";
import { parseSongSheet } from "@/lib/song-sheet";
import type { SheetSong } from "@/lib/song-sheet";
import { useNowPlaying, useSessionRun } from "@/player";
import { useConnection } from "@/session/connection";

function ActionRow({
  icon,
  label,
  filled = false,
  done = false,
  onPress,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly filled?: boolean;
  readonly done?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Row
      title={label}
      leading={{ kind: "icon", icon, filled }}
      trailing={done ? <Icon icon={Check} size="inline" /> : undefined}
      onPress={onPress}
    />
  );
}

const leaveFor = (open: () => void) => {
  router.dismissAll();
  open();
};

function Actions({ song }: { readonly song: SheetSong }) {
  const { origin } = useConnection();
  const run = useSessionRun();
  const setLike = useRun("likes.set");
  const readLink = useReadOnce("links.get");
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { nowPlaying } = useNowPlaying();
  const playing = nowPlaying?.trackId === song.id ? nowPlaying : null;

  const finish = async (action: () => Promise<void>) => {
    setFailure(null);

    try {
      await action();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Something went wrong. Try again.");
    }
  };

  const copyLink = async () => {
    setFailure(null);

    try {
      const link = await readLink({ kind: "track", id: song.id });
      await Clipboard.setStringAsync(mediaUrl(origin, link.path));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCopied(true);
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t copy the link.");
    }
  };

  return (
    <SheetLayout title={song.title} subtitle={`${song.artist} · ${song.album}`}>
      <ActionRow
        icon={FastForward}
        filled
        label="Play next"
        onPress={() =>
          void finish(async () => {
            await run("queue.add", { trackIds: [song.id], next: true });
          })
        }
      />
      <ActionRow
        icon={List}
        label="Add to queue"
        onPress={() =>
          void finish(async () => {
            await run("queue.add", { trackIds: [song.id] });
          })
        }
      />
      <DownloadRow
        target={{ kind: "track", id: song.id }}
        tone="default"
        onDone={() => router.back()}
        onFailure={setFailure}
      />
      <ActionRow
        icon={Plus}
        label="Add to playlist"
        onPress={() =>
          router.replace({ pathname: "/song/[id]/add-to-playlist", params: { id: song.id } })
        }
      />
      <ActionRow
        icon={Heart}
        filled={song.liked}
        label={song.liked ? "Unlike song" : "Like song"}
        onPress={() =>
          void finish(async () => {
            await setLike({ trackId: song.id, liked: !song.liked });
          })
        }
      />
      <ActionRow
        icon={Library}
        label="Go to album"
        onPress={() => leaveFor(() => openAlbum({ id: song.albumId }))}
      />
      <ActionRow
        icon={Users}
        label="Go to artist"
        onPress={() => leaveFor(() => openArtist({ id: song.artistId }))}
      />
      <ActionRow
        icon={Link}
        label={copied ? "Link copied" : "Copy link"}
        done={copied}
        onPress={() => void copyLink()}
      />
      {playing === null ? null : (
        <Row
          title="Audio details"
          subtitle={fileDetails(playing)}
          leading={{ kind: "icon", icon: AudioWaveform }}
          trailing={<RowChevron />}
          onPress={() => router.replace("/audio")}
        />
      )}
      {failure === null ? null : (
        <View className="pt-3">
          <Text variant="calloutMedium" tone="danger" accessibilityLiveRegion="polite">
            {failure}
          </Text>
        </View>
      )}
    </SheetLayout>
  );
}

export default function SongActions() {
  const song = parseSongSheet(useLocalSearchParams());

  if (song === null) {
    return (
      <SheetLayout title="Song" subtitle="This song couldn’t be opened. Close and try again." />
    );
  }

  return <Actions song={song} />;
}

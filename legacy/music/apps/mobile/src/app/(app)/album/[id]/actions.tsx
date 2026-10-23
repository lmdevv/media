/**
 * D03b · Album actions, from the ellipsis in an album's header: download it (or cancel or remove
 * the download), play it next, add it to the queue, go to its artist, or copy its link. Queueing
 * and copying confirm in the row, then close.
 */
import { AlbumId } from "@music/commands/ids";
import type { AlbumDetail } from "@music/commands/models";
import { errorMessage } from "@music/sdk/errors";
import { useReadSettled } from "@music/sdk/react";
import { Option, Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { FastForward, List, Share, Users } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useState } from "react";

import { openArtist } from "@/components/browse/rows";
import { DownloadRow } from "@/components/downloads/download-row";
import { useCopyLink } from "@/components/playlists/copy-link";
import { useCloseAfter } from "@/components/playlists/use-close-after";
import { Row, RowCheck } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { Text } from "@/components/ui/text";
import { countOf } from "@/lib/format";
import { usePlayerActions } from "@/player";

const decodeId = Schema.decodeUnknownOption(AlbumId);

/** How long the sheet stays after a quiet confirmation such as Link copied. */
const CONFIRM_MS = 700;

/** The rows that finish in place, then say so. */
type QuietKey = "next" | "later" | "copy";

const QUIET_ACTIONS = {
  next: { label: "Play next", done: "Playing next", icon: FastForward, filled: true },
  later: { label: "Add to queue", done: "Added to queue", icon: List, filled: false },
  copy: { label: "Copy link", done: "Link copied", icon: Share, filled: false },
} as const satisfies Record<
  QuietKey,
  {
    readonly label: string;
    readonly done: string;
    readonly icon: LucideIcon;
    readonly filled: boolean;
  }
>;

/** `Massive Attack · 1991 · 9 songs`. */
const subtitleOf = ({ album, tracks }: AlbumDetail): string =>
  [album.artist, album.year === null ? null : String(album.year), countOf(tracks.length, "song")]
    .filter((part) => part !== null)
    .join(" · ");

function Sheet({ detail }: { readonly detail: AlbumDetail }) {
  const { playNext, playLater } = usePlayerActions();
  const copyLink = useCopyLink();
  const closeSoon = useCloseAfter(CONFIRM_MS);
  const [confirmed, setConfirmed] = useState<QuietKey | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { album } = detail;
  const trackIds = detail.tracks.map((track) => track.id);

  const run = async (key: QuietKey) => {
    setFailure(null);

    try {
      if (key === "next") await playNext(trackIds);
      else if (key === "later") await playLater(trackIds);
      else await copyLink("album", album.id);

      setConfirmed(key);
      closeSoon();
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Something went wrong. Try again.");
    }
  };

  const quiet = (key: QuietKey) => {
    const action = QUIET_ACTIONS[key];
    const done = confirmed === key;

    return (
      <Row
        title={done ? action.done : action.label}
        leading={{ kind: "icon", icon: action.icon, filled: action.filled }}
        trailing={done ? <RowCheck /> : undefined}
        onPress={confirmed === null ? () => void run(key) : undefined}
      />
    );
  };

  return (
    <SheetLayout title={album.title} subtitle={subtitleOf(detail)}>
      <DownloadRow
        target={{ kind: "album", id: album.id }}
        tone="default"
        onDone={() => router.back()}
        onFailure={setFailure}
      />
      {trackIds.length === 0 ? null : quiet("next")}
      {trackIds.length === 0 ? null : quiet("later")}
      <Row
        title="Go to artist"
        leading={{ kind: "icon", icon: Users }}
        onPress={() => {
          router.back();
          openArtist({ id: album.artistId });
        }}
      />
      {quiet("copy")}
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-3">
          {failure}
        </Text>
      )}
    </SheetLayout>
  );
}

export default function AlbumActions() {
  const albumId = Option.getOrNull(decodeId(useLocalSearchParams().id));
  const detail = useReadSettled("albums.get", albumId === null ? "skip" : { albumId });

  if (albumId === null || detail instanceof Error) {
    return (
      <SheetLayout title="Album" subtitle="This album couldn’t be opened. Close and try again." />
    );
  }

  return detail === undefined ? null : <Sheet detail={detail} />;
}

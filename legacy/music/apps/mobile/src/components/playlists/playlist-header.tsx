/**
 * The top of a playlist page, down to its Play button. Its owner sees Paper's hero (C02): 128pt
 * art, the name at 28/32, the description, the mono size line, then who can open it with Share
 * and Add, then Play and Shuffle. Everyone else sees C11: whose playlist it is, what they may do
 * with it, then Play and Shuffle or Add songs. On an iPad both lay out like the album's header
 * (P05): the art on the left, and the size, the name, and the rest beside it.
 */
import type { TrackId } from "@music/commands/ids";
import type { Playlist } from "@music/commands/models";
import { canEditPlaylistItems } from "@music/commands/permissions";
import { router } from "expo-router";
import { Link, Lock, Plus, Share, Users } from "lucide-react-native";
import { View } from "react-native";

import { DetailHeader } from "@/components/browse/detail-header";
import { Artwork } from "@/components/ui/artwork";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Row } from "@/components/ui/row";
import { Text } from "@/components/ui/text";
import {
  accessLine,
  playlistMeta,
  playlistReach,
  reachLabel,
  sharedByLine,
} from "@/lib/playlist-format";

import { PlayButtons } from "./play-buttons";
import type { PlayButtonsProps } from "./play-buttons";

const REACH_ICONS = { private: Lock, people: Users, link: Link } as const;

/** Opens the page that adds songs to a playlist. */
export const openAddSongs = (playlist: Pick<Playlist, "id">): void =>
  router.push({ pathname: "/playlist/[id]/add", params: { id: playlist.id } });

/** C02's privacy row: who can open it, Share for people who may share, and Add. */
function ReachRow({
  playlist,
  canShare,
  className,
}: {
  readonly playlist: Playlist;
  readonly canShare: boolean;
  readonly className?: string;
}) {
  const reach = playlistReach(playlist);

  return (
    <View className={`flex-row items-center gap-2 ${className ?? ""}`}>
      <Icon icon={REACH_ICONS[reach]} tone="muted" size="meta" />
      <Text variant="secondary" tone="muted" className="flex-1">
        {reachLabel(reach)}
      </Text>
      {canShare ? (
        <IconButton
          icon={Share}
          label="Sharing"
          onPress={() =>
            router.push({ pathname: "/playlist/[id]/share", params: { id: playlist.id } })
          }
        />
      ) : null}
      <IconButton icon={Plus} label="Add songs" onPress={() => openAddSongs(playlist)} />
    </View>
  );
}

/** C02's hero, privacy row, and Play and Shuffle; Share shows only to people who may share. */
export function OwnerHeader({
  playlist,
  canShare,
  trackIds,
  tablet,
}: {
  readonly playlist: Playlist;
  readonly canShare: boolean;
  readonly trackIds: ReadonlyArray<TrackId>;
  /** The iPad's header, which carries the name; the page leaves it out of the bar to match. */
  readonly tablet: boolean;
}) {
  const art = playlist.artUrls[0] ?? null;
  const meta = playlistMeta(playlist.trackCount, playlist.durationMs);

  if (tablet) {
    return (
      <DetailHeader
        art={{ url: art }}
        facts={meta}
        title={playlist.name}
        actions={
          <>
            <ReachRow playlist={playlist} canShare={canShare} />
            <PlayButtons trackIds={trackIds} second={{ kind: "shuffle" }} width="natural" />
          </>
        }
      >
        {playlist.description === null ? null : (
          <Text variant="body" tone="muted" numberOfLines={3}>
            {playlist.description}
          </Text>
        )}
      </DetailHeader>
    );
  }

  return (
    <>
      <View className="flex-row items-center gap-4 pb-4">
        <Artwork url={art} className="size-ios-128 rounded-lg" />
        <View className="min-w-0 flex-1 gap-2">
          <Text variant="title" numberOfLines={2} accessibilityRole="header">
            {playlist.name}
          </Text>
          {playlist.description === null ? null : (
            <Text variant="callout" tone="muted" numberOfLines={3}>
              {playlist.description}
            </Text>
          )}
          <Text variant="mono" tone="muted">
            {meta}
          </Text>
        </View>
      </View>
      <ReachRow playlist={playlist} canShare={canShare} className="pb-4" />
      <PlayButtons trackIds={trackIds} second={{ kind: "shuffle" }} className="pb-3" />
    </>
  );
}

/** C11's note on what a collaborator or viewer may do. */
function AccessNotice({ playlist }: { readonly playlist: Playlist }) {
  const ownerName = playlist.owner?.name ?? "The owner";

  return playlist.access === "collaborator" ? (
    <Notice
      icon={Users}
      title="Build it together"
      body={`You can add, remove, and reorder songs. ${ownerName} manages sharing.`}
    />
  ) : (
    <Notice
      icon={Users}
      title="Listen along"
      body={`You can play this playlist. ${ownerName} chooses its songs.`}
    />
  );
}

/** C11's owner row, the note on what the viewer may do, and Play beside Shuffle or Add songs. */
export function SharedHeader({
  playlist,
  trackIds,
  tablet,
}: {
  readonly playlist: Playlist;
  readonly trackIds: ReadonlyArray<TrackId>;
  /** The iPad's header, which carries the name; the page leaves it out of the bar to match. */
  readonly tablet: boolean;
}) {
  const art = playlist.artUrls[0] ?? null;

  const second: PlayButtonsProps["second"] = canEditPlaylistItems(playlist.access)
    ? { kind: "add", onPress: () => openAddSongs(playlist) }
    : { kind: "shuffle" };

  if (tablet) {
    return (
      <DetailHeader
        art={{ url: art }}
        facts={playlistMeta(playlist.trackCount, playlist.durationMs)}
        title={playlist.name}
        actions={
          <>
            <AccessNotice playlist={playlist} />
            <PlayButtons trackIds={trackIds} second={second} width="natural" />
          </>
        }
      >
        <Text variant="subtitle">{sharedByLine(playlist.owner)}</Text>
        <Text variant="callout" tone="muted">
          {accessLine(playlist.access)}
        </Text>
      </DetailHeader>
    );
  }

  return (
    <>
      <Row
        title={sharedByLine(playlist.owner)}
        subtitle={accessLine(playlist.access)}
        leading={{ kind: "art", url: art }}
      />
      <View className="pt-3">
        <AccessNotice playlist={playlist} />
      </View>
      <PlayButtons trackIds={trackIds} second={second} className="py-4" />
    </>
  );
}

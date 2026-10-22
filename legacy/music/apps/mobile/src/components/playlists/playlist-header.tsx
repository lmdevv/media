/**
 * The top of a playlist page. Its owner sees Paper's hero (C02): 128pt art, the name at 28/32,
 * the description, the mono size line, then who can open it with Share and Add. Everyone else
 * sees C11: whose playlist it is and what they may do with it.
 */
import type { Playlist } from "@music/commands/models";
import { router } from "expo-router";
import { Link, Lock, Plus, Share, Users } from "lucide-react-native";
import { View } from "react-native";

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

const REACH_ICONS = { private: Lock, people: Users, link: Link } as const;

/** Opens the page that adds songs to a playlist. */
export const openAddSongs = (playlist: Pick<Playlist, "id">): void =>
  router.push({ pathname: "/playlist/[id]/add", params: { id: playlist.id } });

/** C02's hero and privacy row; Share shows only to people who may share. */
export function OwnerHeader({
  playlist,
  canShare,
}: {
  readonly playlist: Playlist;
  readonly canShare: boolean;
}) {
  const reach = playlistReach(playlist);

  return (
    <>
      <View className="flex-row items-center gap-4 pb-4">
        <Artwork url={playlist.artUrls[0] ?? null} className="size-ios-128 rounded-lg" />
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
            {playlistMeta(playlist.trackCount, playlist.durationMs)}
          </Text>
        </View>
      </View>
      <View className="flex-row items-center gap-2 pb-4">
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
    </>
  );
}

/** C11's owner row and the note on what a collaborator or viewer may do. */
export function SharedHeader({ playlist }: { readonly playlist: Playlist }) {
  const ownerName = playlist.owner?.name ?? "The owner";

  return (
    <>
      <Row
        title={sharedByLine(playlist.owner)}
        subtitle={accessLine(playlist.access)}
        leading={{ kind: "art", url: playlist.artUrls[0] ?? null }}
      />
      <View className="pt-3">
        {playlist.access === "collaborator" ? (
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
        )}
      </View>
    </>
  );
}

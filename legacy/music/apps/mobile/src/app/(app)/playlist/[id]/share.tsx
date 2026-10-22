/**
 * C09 · Sharing: the owner chooses whether the link opens for everyone on the server, sees who
 * has access and in which role, adds people (C10), and copies the link. Only the owner gets here;
 * the server refuses everyone else.
 */
import { PlaylistId } from "@music/commands/ids";
import type { Playlist, PlaylistSharing, PlaylistVisibility } from "@music/commands/models";
import { errorMessage } from "@music/sdk/errors";
import { useRead, useRun } from "@music/sdk/react";
import type { ErrorBoundaryProps } from "expo-router";
import { router, useLocalSearchParams } from "expo-router";
import { Check, Lock, Plus, Share, Users } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { useCopyPlaylistLink } from "@/components/playlists/copy-link";
import { ContentUnavailable } from "@/components/states/content-unavailable";
import { unavailableFrom } from "@/lib/detail-state";
import { usePlaylist } from "@/components/playlists/use-playlist";
import { Button } from "@/components/ui/button";
import { ChipGroup } from "@/components/ui/chip";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { ownershipLine, roleName } from "@/lib/playlist-format";

const VISIBILITIES = [
  { value: "private", label: "Private" },
  { value: "shared", label: "Shared by link" },
] as const;

const LINK_NOTICES = {
  private: {
    title: "Only people you add",
    body: "The link opens only for you and the people below.",
  },
  shared: {
    title: "People on this server only",
    body: "The link opens for signed-in people who can access the music.",
  },
} as const satisfies Record<PlaylistVisibility, { readonly title: string; readonly body: string }>;

/** How long Copy playlist link says it copied. */
const COPIED_MS = 2000;

function Sharing({
  playlist,
  sharing,
}: {
  readonly playlist: Playlist;
  readonly sharing: PlaylistSharing;
}) {
  const setVisibility = useRun("playlists.visibility");
  const copyLink = useCopyPlaylistLink();
  // The choice shows at once; the server's answer replaces it, or a failure puts it back.
  const [choice, setChoice] = useState<PlaylistVisibility | null>(null);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const visibility = choice ?? sharing.visibility;

  const changeVisibility = async (next: PlaylistVisibility) => {
    setChoice(next);
    setFailure(null);

    try {
      await setVisibility({ playlistId: playlist.id, visibility: next });
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t change link access.");
    } finally {
      setChoice(null);
    }
  };

  const copy = async () => {
    setFailure(null);

    try {
      await copyLink(playlist.id);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t copy the link.");
    }
  };

  const openPerson = (userId: string) =>
    router.push({ pathname: "/playlist/[id]/share/[userId]", params: { id: playlist.id, userId } });

  const addPeople = () =>
    router.push({ pathname: "/playlist/[id]/share/add", params: { id: playlist.id } });

  return (
    <Page
      title="Sharing"
      bottom="plain"
      trailing={<IconButton icon={Plus} label="Add people" onPress={addPeople} />}
    >
      <Row
        title={playlist.name}
        subtitle={ownershipLine(playlist, "sharing")}
        leading={{ kind: "art", url: playlist.artUrls[0] ?? null }}
      />
      <SectionHeader title="Link access" />
      <ChipGroup
        label="Link access"
        options={VISIBILITIES}
        value={visibility}
        onChange={(next) => void changeVisibility(next)}
      />
      <Notice
        icon={Lock}
        title={LINK_NOTICES[visibility].title}
        body={LINK_NOTICES[visibility].body}
      />
      <SectionHeader
        title="People with access"
        action={{ kind: "link", label: "Add", onPress: addPeople }}
      />
      <Row title="You" subtitle="Owner" leading={{ kind: "icon", icon: Users, tone: "muted" }} />
      {sharing.people.map((entry) => (
        <Row
          key={entry.person.id}
          title={entry.person.name}
          subtitle={roleName(entry.role)}
          leading={{ kind: "icon", icon: Users, tone: "muted" }}
          trailing={<RowChevron />}
          onPress={() => openPerson(entry.person.id)}
        />
      ))}
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-3">
          {failure}
        </Text>
      )}
      <View className="pt-mobile-edge">
        <Button
          label={copied ? "Link copied" : "Copy playlist link"}
          icon={copied ? Check : Share}
          variant="secondary"
          onPress={() => void copy()}
        />
      </View>
    </Page>
  );
}

export default function SharingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistId = PlaylistId.make(id);
  const state = usePlaylist(playlistId);
  const sharing = useRead("playlists.sharing", { playlistId });

  if (state.kind === "unavailable" || state.kind === "failed") {
    return <ContentUnavailable kind="playlist" state={state} />;
  }

  if (state.kind === "loading" || sharing === undefined) {
    return (
      <Page title="Sharing" bottom="plain">
        {null}
      </Page>
    );
  }

  return <Sharing playlist={state.detail.playlist} sharing={sharing} />;
}

/** G10 when only the owner may see who it is shared with, or the playlist went away. */
export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return <ContentUnavailable kind="playlist" state={unavailableFrom(error)} />;
}

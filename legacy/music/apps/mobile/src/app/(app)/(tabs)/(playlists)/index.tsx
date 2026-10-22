/**
 * C01 · Playlists: the playlists you made and the ones people shared with you, behind Yours and
 * Shared with you chips, with Liked songs first and New playlist in the title row.
 */
import type { Playlist } from "@music/commands/models";
import { useRead } from "@music/sdk/react";
import { router } from "expo-router";
import { Heart, ListMusic, Plus, Users } from "lucide-react-native";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ChipGroup } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Row, RowChevron } from "@/components/ui/row";
import { TabRoot } from "@/components/ui/tab-root";
import { countOf } from "@/lib/format";
import { playlistLine } from "@/lib/playlist-format";

/** Which playlists the list shows. */
type Shelf = "yours" | "shared";

const SHELVES = [
  { value: "yours", label: "Yours" },
  { value: "shared", label: "Shared with you" },
] as const;

/** How many likes the first page reads; past it the count says `200+`. */
const LIKES_PAGE = 200;

const openNew = () => router.push("/playlist/new");

/** Liked songs, in accent, with how many there are. */
function LikedRow() {
  const page = useRead("likes.page", { limit: LIKES_PAGE });
  const count = page === undefined ? null : page.items.length;

  return (
    <Row
      title="Liked songs"
      subtitle={
        count === null
          ? " "
          : page?.done === true
            ? countOf(count, "song")
            : `${String(count)}+ songs`
      }
      leading={{ kind: "icon", icon: Heart, tone: "accent" }}
      active
      trailing={<RowChevron />}
      onPress={() => router.push("/liked")}
    />
  );
}

function PlaylistRows({ playlists }: { readonly playlists: ReadonlyArray<Playlist> }) {
  return playlists.map((playlist) => (
    <Row
      key={playlist.id}
      title={playlist.name}
      subtitle={playlistLine(playlist)}
      leading={{ kind: "art", url: playlist.artUrls[0] ?? null, recyclingKey: playlist.id }}
      trailing={<RowChevron />}
      onPress={() => router.push({ pathname: "/playlist/[id]", params: { id: playlist.id } })}
    />
  ));
}

function Yours() {
  const playlists = useRead("playlists.list", {});

  return (
    <>
      <LikedRow />
      {playlists === undefined ? null : playlists.length === 0 ? (
        <EmptyState
          icon={ListMusic}
          title="Start a playlist."
          body={"Gather songs for a mood,\na trip, or a friend."}
          primary={<Button label="New playlist" icon={Plus} onPress={openNew} />}
        />
      ) : (
        <PlaylistRows playlists={playlists} />
      )}
    </>
  );
}

function Shared() {
  const playlists = useRead("playlists.shared", {});

  if (playlists === undefined) return null;

  if (playlists.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Nothing shared yet."
        body={"Playlists people share with you\nshow up here."}
      />
    );
  }

  return <PlaylistRows playlists={playlists} />;
}

export default function Playlists() {
  const [shelf, setShelf] = useState<Shelf>("yours");

  return (
    <TabRoot
      title="Playlists"
      action={<IconButton icon={Plus} label="New playlist" onPress={openNew} />}
    >
      <ChipGroup label="Show" options={SHELVES} value={shelf} onChange={setShelf} />
      {shelf === "yours" ? <Yours /> : <Shared />}
    </TabRoot>
  );
}

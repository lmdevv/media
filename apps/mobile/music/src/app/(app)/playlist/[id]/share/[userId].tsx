import { PlaylistId } from "@/lib/ids";
import { useLocalSearchParams } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";

import { SheetUnavailable } from "@/components/playlists/unavailable";
import { usePeopleDirectory } from "@/components/playlists/use-playlists";
import { useMusic, useRead } from "@/lib/platform";
import { unavailableFrom } from "@/lib/detail-state";
import { RoleSheet } from "@/components/playlists/role-sheet";

export default function ChooseRole() {
  const { id, userId } = useLocalSearchParams<{ id: string; userId: string }>();
  const playlistId = PlaylistId.make(id);
  const sharing = useRead(useMusic().playlists.sharing, { playlistId });
  const directory = usePeopleDirectory();

  if (sharing === undefined || directory === undefined) return null;

  const share = sharing.people.find((entry) => entry.person.id === userId);
  const person = share?.person ?? directory.find((entry) => entry.id === userId);

  if (person === undefined) return null;

  return <RoleSheet playlistId={playlistId} person={person} current={share?.role ?? null} />;
}

/** The sheet's G10 when the playlist goes away or access ends while it is open. */
export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return <SheetUnavailable state={unavailableFrom(error)} />;
}

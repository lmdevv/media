/**
 * C10 · Choose a role, for someone the playlist is shared with (or, through a link, someone on the
 * server it isn't shared with yet).
 */
import { PlaylistId } from "@music/commands/ids";
import { useRead } from "@music/sdk/react";
import { useLocalSearchParams } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";

import { SheetUnavailable } from "@/components/playlists/unavailable";
import { unavailableFrom } from "@/lib/detail-state";
import { RoleSheet } from "@/components/playlists/role-sheet";

export default function ChooseRole() {
  const { id, userId } = useLocalSearchParams<{ id: string; userId: string }>();
  const playlistId = PlaylistId.make(id);
  const sharing = useRead("playlists.sharing", { playlistId });
  const directory = useRead("people.directory", {});

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

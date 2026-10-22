/**
 * Add people (C09's Add): everyone on the server the playlist isn't shared with yet, then C10's
 * role choice for the one picked, in the same sheet.
 */
import { PlaylistId } from "@music/commands/ids";
import type { DirectoryPerson } from "@music/commands/models";
import { roleLabel } from "@music/commands/permissions";
import { useRead } from "@music/sdk/react";
import { useLocalSearchParams } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";
import { Users } from "lucide-react-native";
import { useState } from "react";

import { SheetUnavailable } from "@/components/playlists/unavailable";
import { unavailableFrom } from "@/lib/detail-state";
import { RoleSheet } from "@/components/playlists/role-sheet";
import { Row, RowChevron } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";

export default function AddPeople() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistId = PlaylistId.make(id);
  const sharing = useRead("playlists.sharing", { playlistId });
  const directory = useRead("people.directory", {});
  const [picked, setPicked] = useState<DirectoryPerson | null>(null);

  if (picked !== null) {
    return <RoleSheet playlistId={playlistId} person={picked} current={null} />;
  }

  if (sharing === undefined || directory === undefined) return null;

  const shared = new Set(sharing.people.map((entry) => entry.person.id));
  const candidates = directory.filter((person) => !shared.has(person.id));

  return (
    <SheetLayout
      title="Add people"
      subtitle={
        candidates.length === 0
          ? "Everyone on this server already has access."
          : "Choose someone on this server."
      }
    >
      {candidates.map((person) => (
        <Row
          key={person.id}
          title={person.name}
          subtitle={roleLabel(person.role)}
          leading={{ kind: "icon", icon: Users, tone: "muted" }}
          trailing={<RowChevron />}
          onPress={() => setPicked(person)}
        />
      ))}
    </SheetLayout>
  );
}

/** The sheet's G10 when the playlist goes away or access ends while it is open. */
export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return <SheetUnavailable state={unavailableFrom(error)} />;
}

/**
 * C10 · Share with someone: Viewer or Collaborator as a single-select list with an accent check,
 * then Share playlist, and Remove access for someone it is already shared with.
 */
import type { PlaylistId, UserId } from "@music/commands/ids";
import type { PlaylistRole } from "@music/commands/models";
import { errorMessage } from "@music/sdk/errors";
import { useRun } from "@music/sdk/react";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { ListMusic, Users } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Row, RowCheck } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { Text } from "@/components/ui/text";
import { roleName } from "@/lib/playlist-format";

const ROLES: ReadonlyArray<{
  readonly role: PlaylistRole;
  readonly icon: LucideIcon;
  readonly summary: string;
}> = [
  { role: "viewer", icon: Users, summary: "View and play songs" },
  { role: "collaborator", icon: ListMusic, summary: "Add, remove, and reorder songs" },
];

/** Which request is running, so only its button shows progress. */
type Pending = "share" | "remove" | null;

/** Props for `RoleSheet`. */
export interface RoleSheetProps {
  readonly playlistId: PlaylistId;
  readonly person: { readonly id: UserId; readonly name: string };
  /** Their role now, or null when the playlist isn't shared with them yet. */
  readonly current: PlaylistRole | null;
}

/** Shares the playlist with one person in the chosen role, or takes their access away. */
export function RoleSheet({ playlistId, person, current }: RoleSheetProps) {
  const share = useRun("playlists.share");
  const unshare = useRun("playlists.unshare");
  const [role, setRole] = useState<PlaylistRole>(current ?? "viewer");
  const [pending, setPending] = useState<Pending>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const send = async (kind: Exclude<Pending, null>) => {
    setPending(kind);
    setFailure(null);

    try {
      await (kind === "share"
        ? share({ playlistId, userId: person.id, role })
        : unshare({ playlistId, userId: person.id }));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Something went wrong. Try again.");
      setPending(null);
    }
  };

  return (
    <SheetLayout
      title={`Share with ${person.name}`}
      subtitle={`Choose what ${person.name} can do.`}
      actions={
        <>
          <Button
            label="Share playlist"
            pendingLabel="Sharing…"
            pending={pending === "share"}
            disabled={pending === "remove"}
            onPress={() => void send("share")}
          />
          {current === null ? null : (
            <Button
              label="Remove access"
              pendingLabel="Removing…"
              variant="destructive"
              pending={pending === "remove"}
              disabled={pending === "share"}
              className="mt-1"
              onPress={() => void send("remove")}
            />
          )}
        </>
      }
    >
      {ROLES.map((option) => (
        <Row
          key={option.role}
          title={roleName(option.role)}
          subtitle={option.summary}
          leading={{ kind: "icon", icon: option.icon, tone: "muted" }}
          trailing={option.role === role ? <RowCheck /> : undefined}
          accessibilityLabel={`${roleName(option.role)}, ${option.summary}${option.role === role ? ", selected" : ""}`}
          onPress={() => {
            void Haptics.selectionAsync();
            setRole(option.role);
          }}
        />
      ))}
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-3">
          {failure}
        </Text>
      )}
    </SheetLayout>
  );
}

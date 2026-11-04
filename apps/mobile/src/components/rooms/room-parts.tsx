import type { Room } from "@media/contracts/models/rooms";
import { Pause, Play } from "lucide-react-native";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import type { MemberRow } from "@/lib/rooms/room-view";

import { Spinner } from "../player/spinner";

/** The title's wide artwork (G01, G03), 16:9 with the card radius. */
export function RoomArtwork({
  uri,
  children,
}: {
  readonly uri: string | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <View className="aspect-video w-full overflow-hidden rounded-card bg-surface">
      {uri === undefined ? null : (
        <Image source={{ uri }} contentFit="cover" className="absolute inset-0" />
      )}
      {children}
    </View>
  );
}

/**
 * The artwork of a room the device is in (G02, G04, G05), dimmed under the shared timeline's state:
 * pause while it plays, play while it is paused, a spinner while the host buffers. Pressing it
 * opens the room's player.
 */
export function RoomStage({
  uri,
  status,
  title,
  onWatch,
}: {
  readonly uri: string | undefined;
  readonly status: Room["clock"]["status"];
  readonly title: string;
  readonly onWatch: () => void;
}) {
  return (
    <Pressable
      onPress={onWatch}
      accessibilityRole="button"
      accessibilityLabel={`Watch ${title} in the room`}
      className="active:opacity-80"
    >
      <RoomArtwork uri={uri}>
        <View className="absolute inset-0 items-center justify-center bg-scrim">
          {status === "buffering" ? (
            <Spinner />
          ) : (
            <Icon icon={status === "playing" ? Pause : Play} tone="onMedia" size="state" filled />
          )}
        </View>
      </RoomArtwork>
    </Pressable>
  );
}

/** One person in the room (G02): a 44pt tile, the name, and how they stand. */
export function RoomMemberRow({ row }: { readonly row: MemberRow }) {
  return (
    <View
      className="flex-row items-center gap-3"
      accessible
      accessibilityLabel={row.detail === null ? row.name : `${row.name}, ${row.detail}`}
    >
      <ProfileAvatar
        profile={{ name: row.name, avatar: row.avatar ?? "", kids: false }}
        size="member"
      />
      <Text variant="bodyMedium" className="flex-1" numberOfLines={1}>
        {row.name}
      </Text>
      {row.detail === null ? null : (
        <Text variant="secondary" tone="muted" numberOfLines={1}>
          {row.detail}
        </Text>
      )}
    </View>
  );
}

/** The time now, read again every `everyMs` while `running`. */
export const useNow = (running: boolean, everyMs: number): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());

    if (!running) return undefined;

    const timer = setInterval(() => setNow(Date.now()), everyMs);

    return () => clearInterval(timer);
  }, [running, everyMs]);

  return now;
};

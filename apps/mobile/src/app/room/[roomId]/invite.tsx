import { useCommandQuery } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { Ellipsis, Link, Share as ShareIcon } from "lucide-react-native";
import { useState } from "react";
import { Linking, Share } from "react-native";

import { useCopyLink } from "@/components/rooms/room-actions";
import { roomIdParam } from "@/components/title/route-params";
import { Sheet } from "@/components/title/sheet";
import { ListRow } from "@/components/ui/list-row";
import { messagesUrl, roomLink } from "@/lib/rooms/room-view";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

export default function InviteToRoom() {
  const params = useLocalSearchParams<{ roomId: string }>();
  const roomId = roomIdParam(params.roomId);
  const { profile } = useActiveProfile();
  const { mediaUrl } = useServer();
  const copying = useCopyLink();
  const [error, setError] = useState<string | null>(null);

  const read = useCommandQuery(
    "rooms.get",
    roomId === null ? "skip" : { roomId, profileId: profile.id },
  );

  if (roomId === null) return <Sheet title="Invite to Watch" />;

  const link = roomLink(mediaUrl, roomId);
  const name = read.status === "success" ? read.data.title.name : undefined;

  return (
    <Sheet title="Invite to Watch" subtitle={name} error={error ?? copying.error}>
      <ListRow
        icon={Link}
        title="Copy Room Link"
        {...(copying.copied ? { detail: "Copied" } : {})}
        onPress={() => {
          setError(null);
          copying.copy(link);
        }}
      />
      <ListRow
        icon={ShareIcon}
        title="Messages"
        onPress={() => {
          setError(null);
          void Linking.openURL(messagesUrl(link)).catch(() =>
            setError("Messages isn’t available."),
          );
        }}
      />
      <ListRow
        icon={Ellipsis}
        title="More Sharing Options"
        onPress={() => {
          void Share.share({ url: link }).catch(() => undefined);
        }}
      />
    </Sheet>
  );
}

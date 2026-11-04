import { RoomId } from "@media/contracts/ids";
import { useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { Spinner } from "@media/ui/components/spinner";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Predicate, Schema } from "effect";
import { useEffect } from "react";

import { RoomDenied } from "@/components/player/room-states";
import { returnTarget } from "@/lib/current-room";
import { describeFailure } from "@/lib/failure";
import { RequireProfile, RequireSignedIn, useActiveProfile } from "@/session/guards";

const decodeRoomId = Schema.decodeSync(RoomId);

/**
 * A room link, `/r/<roomId>`: account holders only. It opens the player in the room, or says why
 * it cannot: the room ended, or the active profile cannot see what it plays.
 */
export const Route = createFileRoute("/r/$roomId")({
  params: {
    parse: (raw) => ({ roomId: decodeRoomId(raw.roomId) }),
    stringify: (params) => ({ roomId: params.roomId }),
  },
  head: () => ({ meta: [{ title: "Watch together · [movies]" }] }),
  component: () => (
    <RequireSignedIn>
      <RequireProfile>
        <RoomLinkPage />
      </RequireProfile>
    </RequireSignedIn>
  ),
});

const home = (className: string) => (
  <Link to="/" className={className}>
    Go to Home
  </Link>
);

function RoomLinkPage() {
  const { roomId } = Route.useParams();
  const navigate = useNavigate();
  const { profile } = useActiveProfile();
  const room = useCommandQuery("rooms.get", { roomId, profileId: profile.id });
  const open = room.status === "success" && room.data.clock.status !== "ended" ? room.data : null;

  useEffect(() => {
    if (open === null) return;

    void navigate({
      ...returnTarget({ id: open.id, titleId: open.title.id, episodeId: open.episode?.id ?? null }),
      replace: true,
    });
  }, [open, navigate]);

  if (room.status === "success" && room.data.clock.status === "ended") {
    return (
      <RoomDenied
        denial={{ kind: "ended", hostName: room.data.hostProfileName }}
        home={home}
        switchProfile={() => void navigate({ to: "/profiles" })}
      />
    );
  }

  if (room.status === "error") {
    return Predicate.isTagged(room.error, "NotFound") ? (
      <RoomDenied
        denial={{ kind: "household", hostName: null }}
        home={home}
        switchProfile={() => void navigate({ to: "/profiles" })}
      />
    ) : (
      <div className="on-media flex min-h-svh items-center justify-center bg-dark-bg px-6">
        <CalmState
          title="Can't open this room"
          description={describeFailure(room.error)}
          actions={<Button onClick={room.retry}>Try again</Button>}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-dark-bg">
      <Spinner className="size-12 text-text" label="Opening the room" />
    </div>
  );
}

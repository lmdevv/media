import type { EpisodeId, MediaFileId, RoomId } from "@media/contracts/ids";
import type { Room } from "@media/contracts/models/rooms";
import { Milliseconds } from "@media/contracts/units";
import type { PlayerPort, RoomSync } from "@media/sdk/effect";
import { useCommand, useCommandQuery, useRoomSync } from "@media/sdk/react";
import { Result } from "effect";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import {
  ChevronLeft,
  Link2,
  Play,
  Share as ShareIcon,
  UserRound,
  UsersRound,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Share, View } from "react-native";

import { Image } from "@/components/ui/image";
import { artworkUrl } from "@/lib/artwork";
import { deviceId } from "@/lib/device";
import { describeFailure } from "@/lib/failure";
import { formatClock } from "@/lib/player/clock";
import {
  guestCatchingUp,
  memberRows,
  roomAccess,
  roomLink,
  roomNotice,
  shownLink,
  watchingLabel,
} from "@/lib/rooms/room-view";
import type { MemberRow, RoomAccess, RoomNotice, RoomRole } from "@/lib/rooms/room-view";
import { watchHref } from "@/lib/routes";
import type { WatchParams } from "@/lib/routes";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

import { RoundButton } from "../player/player-controls";
import { Spinner } from "../player/spinner";
import { PlayerPopup, PopupLink, PopupText, PopupTitle } from "./player-popup";
import { goBack, useCopyLink, useJoinRoom, useServerClock } from "./room-actions";

/** The room a player screen opened with, and where this device stands with it. */
export interface RoomGate {
  /** The room in the route now; null once left, or outside rooms. */
  readonly roomId: RoomId | null;
  /**
   * The room the stream belongs to: the one the screen opened with, while still in it. A session
   * that starts again starts in it; one started alone stays alone when a room starts from it.
   */
  readonly opened: RoomId | null;
  readonly access: RoomAccess;
  /** The room this device is in with the active profile, from `access`; null otherwise. */
  readonly joined: Room | null;
  /** Whether playback may start: no room, or the room joined. */
  readonly admitted: boolean;
  /** Reads the room again after it could not be read. */
  readonly retry: (() => void) | null;
  /**
   * The server's time now, by this device's estimate from one round trip before playback, so
   * the stream starts where the room is even on a phone whose clock is off; the device's own
   * time when the server's could not be read.
   */
  readonly serverNow: () => number;
}

const joinedRoom = (access: RoomAccess): Room | null =>
  access.kind === "member" || access.kind === "hostLeft" ? access.room : null;

const NO_ROOM: RoomAccess = { kind: "loading" };

const playsParams = (room: Room, params: WatchParams): boolean =>
  room.title.id === params.titleId && (room.episode?.id ?? undefined) === params.episodeId;

/** The player's room before playback: joined or not, and what it plays. */
export const useRoomGate = (params: WatchParams): RoomGate => {
  const { profile } = useActiveProfile();
  const roomId = params.room ?? null;

  const read = useCommandQuery(
    "rooms.get",
    roomId === null ? "skip" : { roomId, profileId: profile.id },
  );

  const access = roomId === null ? NO_ROOM : roomAccess(read, deviceId(), profile.id);
  const clock = useServerClock(roomId);
  const [opened, setOpened] = useState(roomId);
  const [admitted, setAdmitted] = useState(roomId === null);

  if (roomId === null && opened !== null) setOpened(null);

  if (!admitted && roomId === null) setAdmitted(true);

  const joined = joinedRoom(access);
  const elsewhere = !admitted && joined !== null && !playsParams(joined, params) ? joined : null;

  if (!admitted && joined !== null && elsewhere === null && clock.read) setAdmitted(true);

  const moveTo =
    elsewhere === null
      ? null
      : watchHref({
          titleId: elsewhere.title.id,
          episodeId: elsewhere.episode?.id,
          room: elsewhere.id,
        });

  useEffect(() => {
    if (moveTo !== null) router.replace(moveTo);
  }, [moveTo]);

  return {
    roomId,
    opened,
    access,
    joined,
    admitted,
    retry: read.status === "error" ? read.retry : null,
    serverNow: () => Date.now() + clock.offsetMs,
  };
};

const closePlayer = goBack;

const switchProfile = (): void => {
  closePlayer();
  router.push("/switch-profile");
};

const dropRoom = (): void => {
  router.setParams({ room: undefined });
};

function JoinPopup({ room, onNotNow }: { readonly room: Room; readonly onNotNow: () => void }) {
  const { mediaUrl } = useServer();
  const { busy, error, join } = useJoinRoom(room.id);

  return (
    <PlayerPopup
      title={`Join ${room.hostProfileName}`}
      onClose={onNotNow}
      error={error}
      actions={[
        { label: "Not Now", kind: "secondary", onPress: onNotNow },
        {
          label: "Join Room",
          kind: "primary",
          icon: UsersRound,
          busy,
          onPress: () => {
            void join();
          },
        },
      ]}
    >
      <PopupTitle
        name={room.title.name}
        detail={`${room.hostProfileName} · Host`}
        artworkUrl={artworkUrl(mediaUrl, room.title.artwork.backdrop, "card")}
      />
    </PlayerPopup>
  );
}

interface RoomStateActions {
  readonly onLeave: () => void;
  readonly onAlone: () => void;
  readonly onRetry: () => void;
  readonly onNotNow: () => void;
}

function RoomStatePopup({
  access,
  subtitle,
  actions,
}: {
  readonly access: RoomAccess;
  readonly subtitle: string | null;
  readonly actions: RoomStateActions;
}) {
  const leave = {
    label: "Leave Player",
    kind: "secondary",
    icon: ChevronLeft,
    onPress: actions.onLeave,
  } as const;

  if (access.kind === "join") return <JoinPopup room={access.room} onNotNow={actions.onNotNow} />;

  if (access.kind === "ended") {
    return (
      <PlayerPopup
        title="This room has ended."
        onClose={actions.onAlone}
        actions={[
          leave,
          {
            label: "Watch on Your Own",
            kind: "primary",
            icon: Play,
            iconFilled: true,
            onPress: actions.onAlone,
          },
        ]}
      >
        {subtitle === null ? null : <PopupText>{subtitle}</PopupText>}
      </PlayerPopup>
    );
  }

  if (access.kind === "denied") {
    return (
      <PlayerPopup
        title="Room unavailable"
        onClose={actions.onLeave}
        actions={[
          leave,
          { label: "Switch Profile", kind: "primary", icon: UserRound, onPress: switchProfile },
        ]}
      >
        <PopupText>This profile can’t watch what this room is playing.</PopupText>
      </PlayerPopup>
    );
  }

  if (access.kind === "failed") {
    return (
      <PlayerPopup
        title="Can’t reach the room"
        onClose={actions.onLeave}
        actions={[leave, { label: "Try Again", kind: "primary", onPress: actions.onRetry }]}
      >
        <PopupText>{describeFailure(access.error)}</PopupText>
      </PlayerPopup>
    );
  }

  return null;
}

/**
 * The player before it joins its room, over the title's artwork: joining, or why it cannot. An
 * ended room's Watch on Your Own opens a player of its own on what the route named, which starts
 * from the profile's progress as any solo player does.
 */
export function RoomEntry({
  gate,
  params,
}: {
  readonly gate: RoomGate;
  readonly params: WatchParams;
}) {
  const { mediaUrl } = useServer();
  const { access } = gate;
  const room = access.kind === "join" ? access.room : null;
  const backdrop = artworkUrl(mediaUrl, room?.title.artwork.backdrop, "backdrop");

  const popup = (
    <RoomStatePopup
      access={access}
      subtitle={null}
      actions={{
        onLeave: closePlayer,
        onAlone: () =>
          router.replace(watchHref({ titleId: params.titleId, episodeId: params.episodeId })),
        onRetry: () => gate.retry?.(),
        onNotNow: closePlayer,
      }}
    />
  );

  return (
    <View className="flex-1 bg-dark-bg">
      {backdrop === undefined ? null : (
        <Image source={{ uri: backdrop }} contentFit="cover" className="absolute inset-0" />
      )}
      <View className="absolute top-0 left-0 h-17 justify-center px-8">
        <RoundButton icon={ChevronLeft} label="Close" onPress={closePlayer} />
      </View>
      {access.kind === "loading" || access.kind === "member" || access.kind === "hostLeft" ? (
        <View className="absolute inset-0 items-center justify-center">
          <Spinner />
        </View>
      ) : (
        popup
      )}
    </View>
  );
}

type OpenedPopup = "start" | "invite" | "end";

/** What the session's room needs from the player. */
export interface SessionRoomOptions {
  readonly gate: RoomGate;
  /** The player, once it shows frames; the engine never drives an empty player. */
  readonly player: PlayerPort | null;
  /** What plays, once the stream started. */
  readonly started: {
    readonly titleId: WatchParams["titleId"];
    readonly episodeId: EpisodeId | null;
    readonly fileId: MediaFileId;
    readonly name: string;
    readonly artwork: string | null;
  } | null;
  /** Where playback is now, for a room started from here. */
  readonly positionMs: () => number;
  /** Plays on alone after the room went away. */
  readonly resume: () => void;
}

/** The room as the player shows it. */
export interface SessionRoom {
  /** The room's record, once joined; null outside rooms. */
  readonly room: Room | null;
  readonly role: RoomRole | null;
  /** The engine's state, once it runs. */
  readonly sync: RoomSync.RoomSyncState | null;
  readonly members: ReadonlyArray<MemberRow>;
  readonly notice: RoomNotice | null;
  readonly watching: string;
  /** A guest still catching up with the room, or waiting while the host buffers. */
  readonly waiting: boolean;
  /** The host buffers and the room waits for it. */
  readonly hostBuffering: boolean;
  readonly pane: boolean;
  readonly setPane: (open: boolean) => void;
  /** Opens Start Room (F15), or the pane once in a room. */
  readonly onTogether: () => void;
  readonly openInvite: () => void;
  readonly openEnd: () => void;
  readonly leave: () => void;
  /** A guest's Continue Watching while the host is away; null otherwise. */
  readonly continueAlone: (() => void) | null;
  /** The popup over the player, or null. */
  readonly popup: ReactNode;
}

/** The session's room: the engine, the pane's state, and the popups. */
export const useSessionRoom = (options: SessionRoomOptions): SessionRoom => {
  const { gate, player, started } = options;
  const { profile } = useActiveProfile();
  const { mediaUrl } = useServer();
  const create = useCommand("rooms.create");
  const leaveRoom = useCommand("rooms.leave");
  const endRoom = useCommand("rooms.end");
  const [opened, setOpened] = useState<OpenedPopup | null>(null);
  const [pane, setPane] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copying = useCopyLink();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [last, setLast] = useState<Room | null>(null);
  const [resumeAlone, setResumeAlone] = useState(false);
  const device = deviceId();
  const { roomId, access } = gate;
  const current = roomId === null ? null : joinedRoom(access);

  if (current !== null && current !== last) setLast(current);

  const held =
    last !== null && last.id === roomId && (access.kind === "failed" || access.kind === "loading")
      ? last
      : null;

  const room = current ?? held;
  const joined = room !== null;

  const role: RoomRole | null =
    room === null ? null : room.hostDeviceId === device ? "host" : "guest";

  const engine = useRoomSync(
    joined ? player : null,
    joined && roomId !== null ? { roomId, deviceId: device, fileId: started?.fileId } : null,
  );

  const sync = engine !== null && Result.isSuccess(engine) ? engine.success : null;
  const hostBuffering = role === "guest" && room?.clock.status === "buffering";

  const catchingUp =
    role === "guest" &&
    room !== null &&
    guestCatchingUp(
      sync === null
        ? null
        : {
            offset: sync.offset,
            follow: sync.follow,
            clockStatus: sync.clock.status,
            driftMs: sync.driftMs,
          },
    );

  const show = (popup: OpenedPopup | null) => {
    setError(null);
    setBusy(false);
    copying.reset();
    setOpened(popup);
  };

  const onTogether = useCallback(() => {
    if (roomId === null) {
      setError(null);
      setBusy(false);
      setOpened("start");
    } else {
      setPane(true);
    }
  }, [roomId]);

  const start = () => {
    if (started === null) return;
    setBusy(true);
    setError(null);

    const input = {
      profileId: profile.id,
      deviceId: device,
      titleId: started.titleId,
      fileId: started.fileId,
      positionMs: Milliseconds.make(Math.max(0, Math.round(options.positionMs()))),
    };

    void create(
      started.episodeId === null ? input : { ...input, episodeId: started.episodeId },
    ).then(
      (created) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        show(null);
        setPane(true);
        router.setParams({ room: created.id });

        return undefined;
      },
      (cause: unknown) => {
        setBusy(false);
        setError(describeFailure(cause));
      },
    );
  };

  const link = roomId === null ? null : roomLink(mediaUrl, roomId);

  const copy = () => {
    if (link !== null) copying.copy(link);
  };

  const share = () => {
    if (link === null) return;
    void Share.share({ url: link }).catch(() => undefined);
  };

  const end = () => {
    if (roomId === null) return;
    setBusy(true);
    setError(null);
    void endRoom({ roomId, deviceId: device }).then(
      () => {
        show(null);
        setPane(false);
        dropRoom();

        return undefined;
      },
      (cause: unknown) => {
        setBusy(false);
        setError(describeFailure(cause));
      },
    );
  };

  const playAlone = () => {
    setPane(false);
    show(null);
    dropRoom();
    setResumeAlone(true);
  };

  const { resume } = options;

  useEffect(() => {
    if (!resumeAlone || joined) return undefined;

    setResumeAlone(false);
    const timer = setTimeout(resume, 0);

    return () => clearTimeout(timer);
  }, [resumeAlone, joined, resume]);

  const leaveWith = (stay: boolean) => {
    if (roomId !== null) void leaveRoom({ roomId, deviceId: device }).catch(() => undefined);

    if (stay) {
      playAlone();
    } else {
      setPane(false);
      show(null);
      closePlayer();
    }
  };

  const hostName = room?.hostProfileName ?? "The host";
  const roomKey = roomId ?? "";

  const derived = (() => {
    if (roomId === null) return null;

    if (access.kind === "hostLeft" && dismissed !== `left:${roomKey}`) {
      return (
        <PlayerPopup
          title={`${hostName} left the room.`}
          onClose={() => {
            setDismissed(`left:${roomKey}`);
            setPane(true);
          }}
          actions={[
            {
              label: "Leave Player",
              kind: "secondary",
              icon: ChevronLeft,
              onPress: () => leaveWith(false),
            },
            {
              label: "Continue Watching",
              kind: "primary",
              icon: Play,
              iconFilled: true,
              onPress: () => leaveWith(true),
            },
          ]}
        >
          <PopupText>
            {`Continue on your own from ${formatClock(access.room.clock.positionAtAnchorMs / 1000)}.`}
          </PopupText>
        </PlayerPopup>
      );
    }

    return (
      <RoomStatePopup
        access={access}
        subtitle={started?.name ?? null}
        actions={{
          onLeave: closePlayer,
          onAlone: playAlone,
          onRetry: () => gate.retry?.(),
          onNotNow: playAlone,
        }}
      />
    );
  })();

  const chosen = (() => {
    if (opened === "start") {
      return started === null ? null : (
        <PlayerPopup
          title="Watch Together"
          onClose={() => show(null)}
          error={error}
          actions={[
            { label: "Cancel", kind: "secondary", onPress: () => show(null) },
            { label: "Start Room", kind: "primary", icon: UsersRound, busy, onPress: start },
          ]}
        >
          <PopupTitle
            name={started.name}
            detail={`Start at ${formatClock(options.positionMs() / 1000)}`}
            artworkUrl={artworkUrl(mediaUrl, started.artwork, "card")}
          />
        </PlayerPopup>
      );
    }

    if (opened === "invite") {
      return link === null ? null : (
        <PlayerPopup
          title="Invite to Watch"
          onClose={() => show(null)}
          error={copying.error}
          actions={[
            {
              label: copying.copied ? "Copied" : "Copy Link",
              kind: "secondary",
              icon: Link2,
              onPress: copy,
            },
            { label: "Share…", kind: "primary", icon: ShareIcon, onPress: share },
          ]}
        >
          {started === null ? null : <PopupText>{started.name}</PopupText>}
          <PopupLink link={shownLink(link)} copied={copying.copied} />
        </PlayerPopup>
      );
    }

    if (opened === "end") {
      return (
        <PlayerPopup
          title="End this room?"
          onClose={() => show(null)}
          error={error}
          actions={[
            { label: "Keep Watching", kind: "secondary", onPress: () => show(null) },
            { label: "End Room", kind: "destructive", busy, onPress: end },
          ]}
        >
          <PopupText>Playback will stop for everyone.</PopupText>
        </PlayerPopup>
      );
    }

    return null;
  })();

  return {
    room,
    role,
    sync,
    members: room === null ? [] : memberRows(room, device),
    notice: room === null || role === null ? null : roomNotice(room, role),
    watching: watchingLabel(room?.members.length ?? 0),
    waiting: hostBuffering || catchingUp,
    hostBuffering,
    pane: pane && room !== null,
    setPane,
    onTogether,
    openInvite: () => show("invite"),
    openEnd: () => show("end"),
    leave: () => leaveWith(false),
    continueAlone: access.kind === "hostLeft" ? () => leaveWith(true) : null,
    popup: chosen ?? derived,
  };
};

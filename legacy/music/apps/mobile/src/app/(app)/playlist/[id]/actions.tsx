/**
 * C08 · Playlist actions. Everyone may queue, download, and copy a link to the playlist. Its owner
 * also edits, shares, and deletes it; a collaborator edits its songs; anyone it was shared with by
 * name may leave it. The server enforces each of these again.
 */
import type { TrackId } from "@music/commands/ids";
import { PlaylistId } from "@music/commands/ids";
import type { Playlist, PlaylistDetail } from "@music/commands/models";
import { can, canEditPlaylistItems, canManagePlaylist } from "@music/commands/permissions";
import { errorMessage } from "@music/sdk/errors";
import { useRead } from "@music/sdk/react";
import type { Href } from "expo-router";
import { router, useLocalSearchParams } from "expo-router";
import {
  CircleArrowDown,
  FastForward,
  List,
  ListMusic,
  LogOut,
  Share,
  Trash2,
  Users,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useState } from "react";

import { DownloadRow } from "@/components/downloads/download-row";
import { SheetUnavailable } from "@/components/playlists/unavailable";
import { usePlaylist } from "@/components/playlists/use-playlist";
import { useCopyLink } from "@/components/playlists/copy-link";
import { useCloseAfter } from "@/components/playlists/use-close-after";
import { Row, RowCheck } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { Text } from "@/components/ui/text";
import { ownershipLine } from "@/lib/playlist-format";
import { usePlayerActions } from "@/player";

/** What the sheet knows when it decides which actions to offer. */
interface Context {
  readonly playlist: Playlist;
  readonly trackIds: ReadonlyArray<TrackId>;
  /** Whether the viewer may share with people at all (guests may not). */
  readonly canShare: boolean;
  /** Whether it is shared with the viewer by name, so there is a share to leave. */
  readonly sharedByName: boolean;
}

/**
 * What a row does: queue songs, keep the playlist on this iPhone (a row that words itself by the
 * download's state), copy the link, or go to another screen.
 */
type Effect =
  | { readonly kind: "queue"; readonly next: boolean }
  | { readonly kind: "download" }
  | { readonly kind: "copy" }
  | {
      readonly kind: "open";
      readonly href: (id: PlaylistId) => Href;
      readonly over: "sheet" | "page";
    };

/** One row of the sheet and who sees it. */
interface Action {
  readonly key: string;
  readonly label: (context: Context) => string;
  readonly icon: LucideIcon;
  readonly filled?: boolean;
  /** The row's quiet confirmation, for actions that finish in place. */
  readonly done?: string;
  readonly when: (context: Context) => boolean;
  readonly effect: Effect;
}

const hasSongs = (context: Context) => context.trackIds.length > 0;

const ACTIONS: ReadonlyArray<Action> = [
  {
    key: "next",
    label: () => "Play next",
    icon: FastForward,
    filled: true,
    done: "Playing next",
    when: hasSongs,
    effect: { kind: "queue", next: true },
  },
  {
    key: "later",
    label: () => "Add to queue",
    icon: List,
    done: "Added to queue",
    when: hasSongs,
    effect: { kind: "queue", next: false },
  },
  {
    key: "download",
    label: () => "Download",
    icon: CircleArrowDown,
    when: () => true,
    effect: { kind: "download" },
  },
  {
    key: "edit",
    label: ({ playlist }) =>
      canManagePlaylist(playlist.access) ? "Edit name, description & songs" : "Edit songs",
    icon: ListMusic,
    when: ({ playlist }) => canEditPlaylistItems(playlist.access),
    effect: {
      kind: "open",
      over: "page",
      href: (id) => ({ pathname: "/playlist/[id]/edit", params: { id } }),
    },
  },
  {
    key: "sharing",
    label: () => "Manage sharing",
    icon: Users,
    when: ({ playlist, canShare }) => canManagePlaylist(playlist.access) && canShare,
    effect: {
      kind: "open",
      over: "page",
      href: (id) => ({ pathname: "/playlist/[id]/share", params: { id } }),
    },
  },
  {
    key: "copy",
    label: () => "Copy link",
    icon: Share,
    done: "Link copied",
    when: () => true,
    effect: { kind: "copy" },
  },
  {
    key: "delete",
    label: () => "Delete playlist",
    icon: Trash2,
    when: ({ playlist }) => canManagePlaylist(playlist.access),
    effect: {
      kind: "open",
      over: "sheet",
      href: (id) => ({ pathname: "/playlist/[id]/delete", params: { id } }),
    },
  },
  {
    key: "leave",
    label: () => "Leave playlist",
    icon: LogOut,
    when: ({ sharedByName }) => sharedByName,
    effect: {
      kind: "open",
      over: "sheet",
      href: (id) => ({ pathname: "/playlist/[id]/leave", params: { id } }),
    },
  },
];

/** How long the sheet stays after a quiet confirmation such as Link copied. */
const CONFIRM_MS = 700;

function Sheet({
  detail,
  context,
}: {
  readonly detail: PlaylistDetail;
  readonly context: Context;
}) {
  const { playNext, playLater } = usePlayerActions();
  const copyLink = useCopyLink();
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const closeSoon = useCloseAfter(CONFIRM_MS);
  const { playlist } = detail;

  const confirm = (key: string) => {
    setConfirmedKey(key);
    closeSoon();
  };

  const run = async (action: Action) => {
    const { effect } = action;
    setFailure(null);

    if (effect.kind === "queue") {
      await (effect.next ? playNext(context.trackIds) : playLater(context.trackIds));
      confirm(action.key);

      return;
    }

    if (effect.kind === "download") return;

    if (effect.kind === "copy") {
      try {
        await copyLink("playlist", playlist.id);
        confirm(action.key);
      } catch (cause) {
        setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t copy the link.");
      }

      return;
    }

    // A sheet takes this one's place; a page opens once this sheet is gone.
    if (effect.over === "sheet") {
      router.replace(effect.href(playlist.id));

      return;
    }

    router.back();
    router.push(effect.href(playlist.id));
  };

  return (
    <SheetLayout title={playlist.name} subtitle={ownershipLine(playlist, "actions")}>
      {ACTIONS.flatMap((action) => {
        if (!action.when(context)) return [];
        const confirmed = confirmedKey === action.key;

        if (action.effect.kind === "download") {
          return [
            <DownloadRow
              key={action.key}
              target={{ kind: "playlist", id: playlist.id }}
              tone="muted"
              onDone={() => router.back()}
              onFailure={setFailure}
            />,
          ];
        }

        return [
          <Row
            key={action.key}
            title={confirmed ? (action.done ?? action.label(context)) : action.label(context)}
            leading={{
              kind: "icon",
              icon: action.icon,
              tone: "muted",
              filled: action.filled ?? false,
            }}
            trailing={confirmed ? <RowCheck /> : undefined}
            onPress={confirmedKey === null ? () => void run(action) : undefined}
          />,
        ];
      })}
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-3">
          {failure}
        </Text>
      )}
    </SheetLayout>
  );
}

export default function PlaylistActions() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistId = PlaylistId.make(id);
  const state = usePlaylist(playlistId);
  const shared = useRead("playlists.shared", {});
  const me = useRead("account.me", {});

  if (state.kind === "unavailable" || state.kind === "failed") {
    return <SheetUnavailable state={state} />;
  }

  if (state.kind === "loading" || shared === undefined || me === undefined) return null;
  const { detail } = state;

  const context: Context = {
    playlist: detail.playlist,
    trackIds: detail.items.flatMap((entry) =>
      entry.available && entry.track !== null ? [entry.track.id] : [],
    ),
    canShare: can(me.role, "share"),
    sharedByName: shared.some((playlist) => playlist.id === playlistId),
  };

  return <Sheet detail={detail} context={context} />;
}

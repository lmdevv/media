import type { TrackId } from "@music/commands/ids";
import type { Playlist, Track } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { useRun } from "@music/sdk/react";
import { Dialog, DialogContent, DialogFooter, DialogClose } from "@music/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@music/ui/components/dropdown-menu";
import { Button } from "@music/ui/components/button";
import { cn } from "@music/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontalIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { toast } from "sonner";

import { Artwork } from "@/components/library/artwork";
import { useUi } from "@/components/shell/ui-state";
import { toastFailure } from "@/lib/action";
import { formatCount, formatDuration, formatQuality } from "@/lib/format";
import { isTyping } from "@/lib/keys";
import { useCopyLink } from "@/lib/use-copy-link";
import { useLike } from "@/lib/use-like";
import { useWritablePlaylists } from "@/lib/use-writable-playlists";

/** Queue actions that report their result as a toast. */
export interface QueueActions {
  readonly playNext: (tracks: ReadonlyArray<Pick<Track, "id" | "title">>) => void;
  readonly addToQueue: (tracks: ReadonlyArray<Pick<Track, "id" | "title">>) => void;
}

/** Adds songs to the end of the queue or right after the current song, with a toast. */
export const useQueueActions = (): QueueActions => {
  const player = usePlayer();

  const add = (tracks: ReadonlyArray<Pick<Track, "id" | "title">>, next: boolean) => {
    const label =
      tracks.length === 1 ? (tracks[0]?.title ?? "") : `${formatCount(tracks.length)} songs`;

    player
      .addToQueue(
        tracks.map((track) => track.id),
        next,
      )
      .then(() => toast.success(next ? `${label} plays next` : `Added ${label} to the queue`))
      .catch(toastFailure);
  };

  return {
    playNext: (tracks) => add(tracks, true),
    addToQueue: (tracks) => add(tracks, false),
  };
};

/** Adds songs to a playlist with a toast that names it. */
export const useAddToPlaylist = (): ((
  playlist: Pick<Playlist, "id" | "name">,
  tracks: ReadonlyArray<TrackId>,
) => void) => {
  const add = useRun("playlists.add");

  return (playlist, tracks) => {
    add({ playlistId: playlist.id, trackIds: tracks })
      .then(() => toast.success(`Added to ${playlist.name}`))
      .catch(toastFailure);
  };
};

function PlaylistSubmenu({ tracks }: { readonly tracks: ReadonlyArray<Track> }) {
  const playlists = useWritablePlaylists();
  const { openNewPlaylist } = useUi();
  const addToPlaylist = useAddToPlaylist();
  const [filter, setFilter] = useState("");

  const shown = (playlists ?? []).filter((playlist) =>
    playlist.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Add to playlist</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <label className="flex h-9 shrink-0 items-center gap-2 rounded-sm bg-surface px-2.5">
          <SearchIcon aria-hidden className="size-3.5 text-text-muted" />
          <input
            aria-label="Find a playlist"
            placeholder="Find a playlist"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            className="min-w-0 grow bg-transparent font-sans text-sm/xs text-text outline-none placeholder:text-text-muted"
          />
        </label>
        <DropdownMenuItem
          onClick={() => openNewPlaylist(tracks.map((track) => track.id))}
          className="h-9 font-medium"
        >
          <PlusIcon aria-hidden />
          New playlist…
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-0.5" />
        {shown.map((playlist) => (
          <DropdownMenuItem
            key={playlist.id}
            className="h-row"
            onClick={() =>
              addToPlaylist(
                playlist,
                tracks.map((track) => track.id),
              )
            }
          >
            <Artwork
              url={playlist.artUrls[0] ?? null}
              seed={playlist.id}
              className="size-6 rounded-2xs"
            />
            <span className="grow truncate">{playlist.name}</span>
          </DropdownMenuItem>
        ))}
        {playlists !== undefined && shown.length === 0 ? (
          <p className="px-2.5 py-2 font-sans text-sm/xs text-text-muted">
            {playlists.length === 0 ? "No playlists yet." : "No playlist matches."}
          </p>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** A file's tags and format, shown from "File info". */
function FileInfoDialog({
  track,
  open,
  onOpenChange,
}: {
  readonly track: Track;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Title", track.title],
    ["Artist", track.artist],
    ["Album", track.album],
    [
      "Track",
      [
        track.discNumber === null ? null : `Disc ${track.discNumber}`,
        track.trackNumber === null ? null : `Track ${track.trackNumber}`,
      ]
        .filter((part) => part !== null)
        .join(" · ") || "—",
    ],
    ["Length", formatDuration(track.durationMs)],
    ["Format", formatQuality(track)],
    ["Codec", track.codec.toUpperCase()],
    ["Lossless", track.lossless ? "Yes" : "No"],
    [
      "Bitrate",
      track.bitrate === null ? "—" : `${formatCount(Math.round(track.bitrate / 1000))} kbps`,
    ],
    [
      "Sample rate",
      track.sampleRate === null ? "—" : `${(track.sampleRate / 1000).toFixed(1)} kHz`,
    ],
    ["Bit depth", track.bitDepth === null ? "—" : `${track.bitDepth}-bit`],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="File info" description={`${track.title} · ${track.artist}`}>
        <dl className="grid grid-cols-[--spacing(30)_1fr] gap-x-4 gap-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="font-mono text-xs/sm tracking-mono text-text-muted uppercase">
                {label}
              </dt>
              <dd className="font-sans text-base/sm text-text">{value}</dd>
            </div>
          ))}
        </dl>
        <DialogFooter>
          <DialogClose render={<Button variant="solid" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The track row menu from Paper (05 Add to playlist): play next, add to queue, add to a playlist,
 * like, go to the album or artist, and file info. `extra` adds context items such as "Remove from
 * this playlist".
 */
export function TrackMenu({
  track,
  trigger,
  extra,
  align = "end",
  className,
  playable = true,
  withheld = false,
}: {
  readonly track: Track;
  readonly trigger?: ReactNode;
  readonly extra?: ReactNode;
  readonly align?: "start" | "end";
  readonly className?: string;
  /** False for a song whose file is gone: the menu leaves out the queue actions. */
  readonly playable?: boolean;
  /**
   * True for a stand-in for a song in a library you can't read: nothing about the song is known,
   * so the menu has only `extra` (such as removing it from the playlist).
   */
  readonly withheld?: boolean;
}) {
  const navigate = useNavigate();
  const { playNext, addToQueue } = useQueueActions();
  const { liked, toggle } = useLike(track);
  const copyLink = useCopyLink();
  const [info, setInfo] = useState(false);
  const [open, setOpen] = useState(false);

  // The keys the menu shows: ⇧↵ play next, Q add to queue, L like. Captured before the menu's own
  // handlers so Shift+Enter does not also activate the highlighted item.
  const onShortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.nativeEvent)) return;

    const key = event.key.toLowerCase();

    const action =
      playable && key === "enter" && event.shiftKey
        ? () => playNext([track])
        : playable && key === "q"
          ? () => addToQueue([track])
          : key === "l" && !withheld
            ? () => void toggle()
            : null;

    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    action();
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          aria-label={`More actions for ${track.title}`}
          onClick={(event) => event.stopPropagation()}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full text-text outline-none hover:bg-border/60 focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-border/60",
            className,
          )}
        >
          {trigger ?? <MoreHorizontalIcon className="size-5" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} onKeyDownCapture={onShortcut}>
          {playable ? (
            <>
              <DropdownMenuItem shortcut="⇧ ↵" onClick={() => playNext([track])}>
                Play next
              </DropdownMenuItem>
              <DropdownMenuItem shortcut="Q" onClick={() => addToQueue([track])}>
                Add to queue
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {withheld ? (
            extra
          ) : (
            <>
              <PlaylistSubmenu tracks={[track]} />
              <DropdownMenuItem shortcut="L" onClick={() => void toggle()}>
                {liked ? "Unlike" : "Like"}
              </DropdownMenuItem>
              {extra === undefined ? null : (
                <>
                  <DropdownMenuSeparator />
                  {extra}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() =>
                  void navigate({ to: "/albums/$albumId", params: { albumId: track.albumId } })
                }
              >
                Go to album
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  void navigate({ to: "/artists/$artistId", params: { artistId: track.artistId } })
                }
              >
                Go to artist
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => copyLink({ kind: "track", id: track.id })}>
                Copy link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setInfo(true)}>File info</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <FileInfoDialog track={track} open={info} onOpenChange={setInfo} />
    </>
  );
}

import type { Track } from "@music/commands/models";
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
import { cn } from "@music/ui/lib/utils";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Artwork } from "@/components/library/artwork";
import { useUi } from "@/components/shell/ui-state";
import { useCopyLink } from "@/lib/use-copy-link";
import type { LinkTarget } from "@/lib/use-copy-link";
import { useWritablePlaylists } from "@/lib/use-writable-playlists";

import { useAddToPlaylist, useQueueActions } from "./track-menu";

/**
 * The "…" menu for a whole album, artist, or playlist: queue it, add it to a playlist, copy a
 * link to it, plus any screen-specific `extra` items such as rename or delete.
 */
export function CollectionMenu({
  tracks,
  label,
  link,
  extra,
  className,
  trigger,
}: {
  readonly tracks: ReadonlyArray<Track>;
  readonly label: string;
  /** What "Copy link" links to; left out when absent. */
  readonly link?: LinkTarget | undefined;
  readonly extra?: ReactNode;
  readonly className?: string;
  readonly trigger?: ReactNode;
}) {
  const { playNext, addToQueue } = useQueueActions();
  const { openNewPlaylist } = useUi();
  const playlists = useWritablePlaylists();
  const copyLink = useCopyLink();
  const addToPlaylist = useAddToPlaylist();
  const empty = tracks.length === 0;
  const ids = tracks.map((track) => track.id);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`More actions for ${label}`}
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-full border border-border text-text outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-surface",
          className,
        )}
      >
        {trigger ?? <MoreHorizontalIcon className="size-4.5" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem disabled={empty} onClick={() => playNext(tracks)}>
          Play next
        </DropdownMenuItem>
        <DropdownMenuItem disabled={empty} onClick={() => addToQueue(tracks)}>
          Add to queue
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={empty}>Add to playlist</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => openNewPlaylist(ids)} className="h-9 font-medium">
              <PlusIcon aria-hidden />
              New playlist…
            </DropdownMenuItem>
            {(playlists ?? []).length > 0 ? <DropdownMenuSeparator className="my-0.5" /> : null}
            {(playlists ?? []).map((playlist) => (
              <DropdownMenuItem
                key={playlist.id}
                className="h-row"
                onClick={() => addToPlaylist(playlist, ids)}
              >
                <Artwork
                  url={playlist.artUrls[0] ?? null}
                  seed={playlist.id}
                  className="size-6 rounded-2xs"
                />
                <span className="grow truncate">{playlist.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {link === undefined ? null : (
          <DropdownMenuItem onClick={() => copyLink(link)}>Copy link</DropdownMenuItem>
        )}
        {extra === undefined ? null : (
          <>
            <DropdownMenuSeparator />
            {extra}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

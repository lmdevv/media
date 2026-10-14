import type { CommandGroup } from "@music/commands/command";
import { commands } from "@music/commands/registry";
import { usePlayer, usePlayerPosition } from "@music/player/react";
import { cn } from "@music/ui/lib/utils";
import {
  DiscIcon,
  FolderIcon,
  HeartIcon,
  KeyRoundIcon,
  ListMusicIcon,
  PlayIcon,
  SearchIcon,
  SpeakerIcon,
  TerminalIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { Artwork } from "@/components/library/artwork";
import { formatDuration, plural } from "@/lib/format";

import { cliOf, titleOf } from "./items";
import type { Item } from "./items";

const GROUP_ICONS: Readonly<Record<CommandGroup, LucideIcon>> = {
  library: DiscIcon,
  search: SearchIcon,
  playback: PlayIcon,
  queue: ListMusicIcon,
  playlists: ListMusicIcon,
  likes: HeartIcon,
  devices: SpeakerIcon,
  libraries: FolderIcon,
  jobs: TerminalIcon,
  keys: KeyRoundIcon,
  people: UsersIcon,
  account: UserRoundIcon,
};

function Thumb({ item }: { readonly item: Item }) {
  switch (item.kind) {
    case "now":
    case "track":
      return (
        <Artwork url={item.track.artUrl} seed={item.track.albumId} className="size-8 rounded-xs" />
      );
    case "album":
      return <Artwork url={item.album.artUrl} seed={item.album.id} className="size-8 rounded-xs" />;
    case "artist":
      return <Artwork url={item.artist.artUrl} seed={item.artist.id} round className="size-8" />;
    case "playlist":
      return (
        <Artwork
          url={item.playlist.artUrls[0] ?? null}
          seed={item.playlist.id}
          className="size-8 rounded-xs"
        />
      );
    case "command": {
      const Icon = GROUP_ICONS[commands[item.name].group];

      return (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface">
          <Icon aria-hidden className="size-4" />
        </span>
      );
    }

    case "action":
      return (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface">
          <item.icon aria-hidden className="size-4" />
        </span>
      );
    default:
      return null;
  }
}

/**
 * One option in the menu's list, with its section header when it starts a section. The row's
 * element ID is `command-<item id>`, which the search field names as its active descendant.
 *
 * @param index - Position in the list, written to `data-index` so the list can scroll to it.
 * @param header - The section name to show above the row, or null inside a section.
 */
export function ItemRow({
  item,
  index,
  active,
  header,
  onHover,
  onSelect,
}: {
  readonly item: Item;
  readonly index: number;
  readonly active: boolean;
  readonly header: string | null;
  readonly onHover: (event: MouseEvent<HTMLDivElement>) => void;
  readonly onSelect: () => void;
}) {
  const player = usePlayer();
  const position = usePlayerPosition();

  const subtitle = ((): string | null => {
    switch (item.kind) {
      case "now":
        return `${player.status === "playing" ? "Playing" : "Paused"} at ${formatDuration(position)} · ${item.track.artist}`;
      case "album":
        return `Album · ${item.album.artist}${item.album.year === null ? "" : ` · ${item.album.year}`}`;
      case "artist":
        return `Artist · ${plural(item.artist.albumCount, "album")}`;
      case "track":
        return `Song · ${item.track.album} · ${formatDuration(item.track.durationMs)}`;
      case "playlist":
        return `Playlist · ${plural(item.playlist.trackCount, "song")}`;
      case "command":
        return cliOf(item.name);
      case "action":
        return null;
    }

    return null;
  })();

  return (
    <>
      {header === null ? null : (
        <span
          className={cn(
            "px-2.5 pb-1.5 font-sans text-xs/xs font-semibold text-text-muted",
            index === 0 ? "pt-2" : "pt-3",
          )}
        >
          {header}
        </span>
      )}
      <div
        id={`command-${item.id}`}
        role="option"
        aria-selected={active}
        data-index={index}
        tabIndex={-1}
        onMouseMove={onHover}
        onClick={onSelect}
        className={cn(
          "flex shrink-0 cursor-pointer items-center gap-3 rounded-md px-2.5",
          subtitle === null ? "h-11" : "h-12",
          active && "bg-surface",
        )}
      >
        <Thumb item={item} />
        <span className="flex min-w-0 grow flex-col gap-px">
          <span
            className={cn(
              "truncate font-sans text-base/sm text-text",
              subtitle !== null && "font-medium",
            )}
          >
            {titleOf(item)}
          </span>
          {subtitle === null ? null : (
            <span className="truncate font-sans text-xs/xs text-text-muted">{subtitle}</span>
          )}
        </span>
        {item.kind === "action" && item.shortcut !== undefined ? (
          <span className="shrink-0 font-mono text-2xs leading-3.5 text-text-muted">
            {item.shortcut}
          </span>
        ) : active ? (
          <span className="shrink-0 font-mono text-2xs leading-3.5 text-text-muted">↵</span>
        ) : null}
      </div>
    </>
  );
}

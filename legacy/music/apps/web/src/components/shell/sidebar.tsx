import { useRead } from "@music/sdk/react";
import { Kbd } from "@music/ui/components/kbd";
import { Tooltip } from "@music/ui/components/tooltip";
import { cn } from "@music/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import {
  DiscIcon,
  HeartIcon,
  HomeIcon,
  MusicIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  UserRoundIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Artwork } from "@/components/library/artwork";
import { initial, plural } from "@/lib/format";
import { MOD } from "@/lib/keys";

import { useUi } from "./ui-state";

const NAV: ReadonlyArray<{
  readonly to: NonNullable<LinkProps["to"]>;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { to: "/", label: "Home", icon: HomeIcon },
  { to: "/search", label: "Search", icon: SearchIcon },
  { to: "/albums", label: "Albums", icon: DiscIcon },
  { to: "/artists", label: "Artists", icon: UserRoundIcon },
  { to: "/songs", label: "Songs", icon: MusicIcon },
  { to: "/liked", label: "Liked songs", icon: HeartIcon },
];

const itemClassName =
  "flex h-9 shrink-0 items-center gap-3 rounded-sm px-2.5 font-sans text-base/sm text-text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-5";

const activeClassName = "bg-bg font-semibold text-text dark:bg-surface-raised";

/**
 * The desktop library sidebar from Paper: wordmark and ⌘K, main navigation, your playlists, and
 * your account. Light mode insets it as a rounded surface; dark mode draws it as a panel.
 */
export function Sidebar() {
  const { setCommandOpen, openNewPlaylist } = useUi();
  const playlists = useRead("playlists.list", {});
  const me = useRead("account.me", {});
  const name = me?.name ?? me?.email ?? "";

  return (
    <nav
      aria-label="Library"
      className="mb-2 hidden w-sidebar shrink-0 flex-col gap-6 rounded-lg border border-border bg-surface px-3 pt-5 pb-4 lg:flex dark:mb-0 dark:rounded-md dark:border-transparent dark:bg-bg"
    >
      <div className="flex h-7 shrink-0 items-center justify-between px-2.5">
        <Link to="/" className="font-mono text-md/base font-semibold tracking-[-0.01em] text-text">
          [music]
        </Link>
        <Tooltip label="Search and commands" shortcut={`${MOD}K`} side="right">
          <button
            type="button"
            aria-label="Open the command menu"
            onClick={() => setCommandOpen(true)}
          >
            <Kbd className="bg-transparent text-xs/xs">{MOD}K</Kbd>
          </button>
        </Tooltip>
      </div>
      <div className="flex flex-col gap-0.5">
        {NAV.map((item) => (
          <Link
            key={item.label}
            to={item.to}
            activeOptions={{ exact: item.to === "/" }}
            className={itemClassName}
            activeProps={{ className: activeClassName, "aria-current": "page" }}
          >
            <item.icon aria-hidden />
            {item.label}
          </Link>
        ))}
      </div>
      <div className="flex min-h-0 grow flex-col gap-0.5">
        <div className="flex items-center justify-between px-2.5 pb-1.5">
          <span className="font-mono text-xs/xs tracking-mono text-text-muted">PLAYLISTS</span>
          <Tooltip label="New playlist" shortcut={"N"}>
            <button
              type="button"
              aria-label="New playlist"
              onClick={() => openNewPlaylist()}
              className="flex size-5 items-center justify-center rounded-sm text-text-muted hover:text-text"
            >
              <PlusIcon className="size-4" />
            </button>
          </Tooltip>
        </div>
        <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {playlists === undefined ? null : playlists.length === 0 ? (
            <p className="px-2.5 py-1 font-sans text-sm/sm text-text-muted">
              Playlists you make show up here.
            </p>
          ) : (
            playlists.map((playlist) => (
              <Link
                key={playlist.id}
                to="/playlists/$playlistId"
                params={{ playlistId: playlist.id }}
                className="flex h-11 shrink-0 items-center gap-2.5 rounded-sm px-1.5 outline-none hover:bg-bg/60 focus-visible:ring-2 focus-visible:ring-ring/50 dark:hover:bg-surface"
                activeProps={{ className: "bg-bg dark:bg-surface-raised", "aria-current": "page" }}
              >
                <Artwork
                  url={playlist.artUrls[0] ?? null}
                  seed={playlist.id}
                  className="size-8 rounded-[4px]"
                />
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="truncate font-sans text-base/sm text-text">{playlist.name}</span>
                  <span className="truncate font-sans text-xs/xs text-text-muted">
                    {plural(playlist.trackCount, "song")}
                  </span>
                </span>
              </Link>
            ))
          )}
        </div>
      </div>
      <Link
        to="/settings"
        className="flex h-11 shrink-0 items-center gap-2.5 rounded-sm px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        activeProps={{ className: "bg-bg dark:bg-surface-raised" }}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-text font-sans text-xs/xs font-semibold text-text-inverse">
          {initial(name)}
        </span>
        <span className="grow truncate font-sans text-base/sm text-text">{name}</span>
        <SlidersHorizontalIcon
          aria-label="Settings"
          className={cn("size-[18px] text-text-muted")}
        />
      </Link>
    </nav>
  );
}

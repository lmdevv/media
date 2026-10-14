import { useRead } from "@music/sdk/react";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  DiscIcon,
  HeartIcon,
  ListMusicIcon,
  MusicIcon,
  UserRoundIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { AlbumCard, PageHeader, SectionHeader } from "@/components/library/cards";

export const Route = createFileRoute("/_app/library")({ component: LibraryPage });

const LINKS: ReadonlyArray<{
  readonly to: NonNullable<LinkProps["to"]>;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { to: "/playlists", label: "Playlists", icon: ListMusicIcon },
  { to: "/artists", label: "Artists", icon: UserRoundIcon },
  { to: "/albums", label: "Albums", icon: DiscIcon },
  { to: "/songs", label: "Songs", icon: MusicIcon },
  { to: "/liked", label: "Liked songs", icon: HeartIcon },
];

/** The phone Library tab: iOS-style rows into each part of the library, then recent albums. */
function LibraryPage() {
  const home = useRead("library.home", {});

  return (
    <div className="flex flex-col gap-6 px-5 pt-safe-top lg:px-12 lg:pt-row">
      <PageHeader title="Library" />
      <nav aria-label="Library" className="flex flex-col">
        {LINKS.map((link) => (
          <Link
            key={link.label}
            to={link.to}
            className="flex h-12 items-center gap-3.5 border-b-hairline border-border font-sans text-lg leading-lg text-text"
          >
            <link.icon aria-hidden className="size-6 text-accent" />
            <span className="grow">{link.label}</span>
            <ChevronRightIcon aria-hidden className="size-5 text-text-muted" />
          </Link>
        ))}
      </nav>
      {home !== undefined && home.recentlyAdded.length > 0 ? (
        <section className="flex flex-col gap-3 pt-2">
          <SectionHeader title="Recently Added" to="/albums" />
          <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
            {home.recentlyAdded.map((album) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

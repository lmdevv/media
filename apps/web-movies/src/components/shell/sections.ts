import { BookmarkIcon, FilmIcon, HouseIcon, TvIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { ShortcutId } from "@/lib/keymap";

/** A top-level section: a top bar link on desktop and a tab on phones. */
export type Section = {
  readonly to: "/" | "/movies" | "/shows" | "/my-list";
  readonly label: string;
  readonly icon: LucideIcon;
  readonly shortcut: ShortcutId;
};

/** The four sections in navigation order. */
export const SECTIONS: ReadonlyArray<Section> = [
  { to: "/", label: "Home", icon: HouseIcon, shortcut: "go.home" },
  { to: "/movies", label: "Movies", icon: FilmIcon, shortcut: "go.movies" },
  { to: "/shows", label: "Shows", icon: TvIcon, shortcut: "go.shows" },
  { to: "/my-list", label: "My List", icon: BookmarkIcon, shortcut: "go.my-list" },
];

/** The section a path belongs to, if any. */
export const sectionOf = (pathname: string): Section | undefined =>
  SECTIONS.find((section) =>
    section.to === "/"
      ? pathname === "/"
      : pathname === section.to || pathname.startsWith(`${section.to}/`),
  );

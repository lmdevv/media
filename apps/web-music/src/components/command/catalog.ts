import type { LinkProps } from "@tanstack/react-router";
import {
  DiscIcon,
  FolderIcon,
  HeartIcon,
  HomeIcon,
  KeyRoundIcon,
  ListMusicIcon,
  MusicIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  TerminalIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  ACCOUNT_API_KEYS,
  ACCOUNT_JOBS,
  ACCOUNT_LIBRARIES,
  ACCOUNT_PEOPLE,
} from "@/lib/account-links";
import { can } from "@/lib/permissions";
import type { Me } from "@/lib/platform";

/** A path in the web app that the menu can navigate to. */
type Route = NonNullable<LinkProps["to"]>;

/** Where a screen is: a route of this client, or a page of the account client at `/`. */
export type Destination =
  | { readonly kind: "route"; readonly to: Route }
  | { readonly kind: "account"; readonly href: string };

interface Screen {
  /** A word search matches, as old music's command name did. */
  readonly name: string;
  readonly title: string;
  readonly destination: Destination;
  readonly icon: LucideIcon;
  /** Who is offered it: anyone, anyone but guests, or admins. */
  readonly offered: "user" | "share" | "admin";
}

const route = (to: Route): Destination => ({ kind: "route", to });

const account = (href: string): Destination => ({ kind: "account", href });

const SCREENS: ReadonlyArray<Screen> = [
  { name: "library.home", title: "Home", destination: route("/"), icon: HomeIcon, offered: "user" },
  {
    name: "search",
    title: "Search",
    destination: route("/search"),
    icon: SearchIcon,
    offered: "user",
  },
  {
    name: "albums.list",
    title: "Albums",
    destination: route("/albums"),
    icon: DiscIcon,
    offered: "user",
  },
  {
    name: "artists.list",
    title: "Artists",
    destination: route("/artists"),
    icon: UserRoundIcon,
    offered: "user",
  },
  {
    name: "tracks.list",
    title: "Songs",
    destination: route("/songs"),
    icon: MusicIcon,
    offered: "user",
  },
  {
    name: "likes.list",
    title: "Liked songs",
    destination: route("/liked"),
    icon: HeartIcon,
    offered: "user",
  },
  {
    name: "playlists.list",
    title: "Playlists",
    destination: route("/playlists"),
    icon: ListMusicIcon,
    offered: "user",
  },
  {
    name: "account.me",
    title: "Account settings",
    destination: route("/settings/account"),
    icon: SettingsIcon,
    offered: "user",
  },
  {
    name: "settings.playback",
    title: "Playback settings",
    destination: route("/settings/playback"),
    icon: SlidersHorizontalIcon,
    offered: "user",
  },
  {
    name: "keys.list",
    title: "API keys",
    destination: account(ACCOUNT_API_KEYS),
    icon: KeyRoundIcon,
    offered: "share",
  },
  {
    name: "people.list",
    title: "People and invites",
    destination: account(ACCOUNT_PEOPLE),
    icon: UsersIcon,
    offered: "admin",
  },
  {
    name: "libraries.list",
    title: "Library folders",
    destination: account(ACCOUNT_LIBRARIES),
    icon: FolderIcon,
    offered: "admin",
  },
  {
    name: "jobs.list",
    title: "Jobs",
    destination: account(ACCOUNT_JOBS),
    icon: TerminalIcon,
    offered: "admin",
  },
];

/** The screens the menu offers under "Go to", in display order: every screen the person may open. */
export const offeredScreens = (role: Me["role"]): ReadonlyArray<Screen> =>
  SCREENS.filter((screen) => can(role, screen.offered));

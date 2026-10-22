import type { Role } from "@music/commands/models";
import { can } from "@music/commands/permissions";
import { commands } from "@music/commands/registry";
import type { CommandName } from "@music/commands/registry";
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
  TerminalIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** A path in the web app that the menu can navigate to. */
export type Route = NonNullable<LinkProps["to"]>;

interface Screen {
  readonly name: CommandName;
  readonly title: string;
  readonly to: Route;
  readonly icon: LucideIcon;
}

/** Query commands open the screen that shows them. */
const SCREENS: ReadonlyArray<Screen> = [
  { name: "library.home", title: "Home", to: "/", icon: HomeIcon },
  { name: "search", title: "Search", to: "/search", icon: SearchIcon },
  { name: "albums.list", title: "Albums", to: "/albums", icon: DiscIcon },
  { name: "artists.list", title: "Artists", to: "/artists", icon: UserRoundIcon },
  { name: "tracks.list", title: "Songs", to: "/songs", icon: MusicIcon },
  { name: "likes.list", title: "Liked songs", to: "/liked", icon: HeartIcon },
  { name: "playlists.list", title: "Playlists", to: "/playlists", icon: ListMusicIcon },
  { name: "account.me", title: "Account settings", to: "/settings/account", icon: SettingsIcon },
  { name: "keys.list", title: "API keys", to: "/settings/keys", icon: KeyRoundIcon },
  { name: "people.list", title: "People and invites", to: "/settings/people", icon: UsersIcon },
  { name: "libraries.list", title: "Library folders", to: "/settings/libraries", icon: FolderIcon },
  { name: "jobs.list", title: "Jobs", to: "/settings/jobs", icon: TerminalIcon },
];

/**
 * The screens the menu offers under "Go to", in display order: every screen whose query command
 * the person may run.
 */
export const offeredScreens = (role: Role): ReadonlyArray<Screen> =>
  SCREENS.filter((screen) => can(role, commands[screen.name].access));

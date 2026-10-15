import type { Role } from "@music/commands/models";
import { can } from "@music/commands/permissions";
import { commands, isCommandName } from "@music/commands/registry";
import type { CommandName, MutationName } from "@music/commands/registry";
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

import { fieldsOf } from "./fields";
import type { FieldSpec } from "./fields";

/** A path in the web app that the menu can navigate to. */
export type Route = NonNullable<LinkProps["to"]>;

/** Commands that only players send; people never run them by hand. */
const INTERNAL: ReadonlySet<CommandName> = new Set([
  "devices.heartbeat",
  "playback.report",
  "stream.url",
]);

/** Commands that need something playing. */
const NEEDS_TRACK: ReadonlySet<CommandName> = new Set([
  "playback.pause",
  "playback.resume",
  "playback.next",
  "playback.previous",
  "playback.seek",
  "playback.jump",
  "queue.remove",
  "queue.clear",
  "playback.shuffle",
  "playback.repeat",
  "playback.volume",
]);

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

/** Narrows a command name to one that changes state. */
const isMutation = (name: CommandName): name is MutationName => commands[name].kind === "mutation";

/**
 * The screens the menu offers under "Go to", in display order: every screen whose query command
 * the person may run.
 */
export const offeredScreens = (role: Role): ReadonlyArray<Screen> =>
  SCREENS.filter((screen) => can(role, commands[screen.name].access));

/**
 * The registry commands the menu offers, in registry order, with their form fields. It leaves out
 * queries (they open screens instead), commands only players send, commands the viewer's role
 * may not run, playback and queue controls while nothing plays, and commands whose arguments no form
 * field can express.
 */
export const offeredCommands = ({
  role,
  playing,
}: {
  /** The viewer's role; each command is offered only to roles with its capability. */
  readonly role: Role;
  /** Whether a song is loaded, playing or paused. */
  readonly playing: boolean;
}): ReadonlyArray<{ readonly name: MutationName; readonly fields: ReadonlyArray<FieldSpec> }> =>
  Object.keys(commands)
    .filter(isCommandName)
    .filter(isMutation)
    .flatMap((name) => {
      const command = commands[name];

      if (INTERNAL.has(name)) return [];

      if (!can(role, command.access)) return [];

      if (!playing && NEEDS_TRACK.has(name)) return [];

      const fields = fieldsOf(name);

      if (fields === null) return [];

      return [{ name, fields }];
    });

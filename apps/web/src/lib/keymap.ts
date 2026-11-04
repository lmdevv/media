import { createKeymap } from "@media/ui/lib/keymap";
import type { KeymapEntry } from "@media/ui/lib/keymap";
import { detectPlatform } from "@media/ui/lib/use-keymap";

const SHORTCUTS = [
  { id: "menu.toggle", keys: "mod+k", whileTyping: true, title: "Search or jump to…" },
  { id: "search.open", keys: "/", title: "Search" },
  { id: "profile.switch", keys: "mod+shift+p", whileTyping: true, title: "Switch profile" },
  { id: "go.home", keys: "g h", title: "Home" },
  { id: "go.movies", keys: "g m", title: "Movies" },
  { id: "go.shows", keys: "g s", title: "Shows" },
  { id: "go.my-list", keys: "g l", title: "My List" },
  { id: "go.settings", keys: "g ,", title: "Settings" },
  { id: "rows.next", keys: "j", title: "Next row" },
  { id: "rows.previous", keys: "k", title: "Previous row" },
] as const satisfies ReadonlyArray<KeymapEntry<string> & { readonly title: string }>;

/** The id of a global shortcut. */
export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

const platform = detectPlatform();

/** The global shortcut registry resolved for this browser's keyboard. */
export const keymap = createKeymap<ShortcutId>(SHORTCUTS, platform);

const PLAYER_SHORTCUTS = [
  { id: "menu.toggle", keys: "mod+k", whileTyping: true, title: "Search or jump to…" },
  { id: "player.toggle", keys: "space", title: "Play or pause" },
  { id: "player.toggle-k", keys: "k", title: "Play or pause" },
  { id: "player.back-10", keys: "j", title: "Back 10 seconds" },
  { id: "player.forward-10", keys: "l", title: "Forward 10 seconds" },
  { id: "player.back-5", keys: "left", title: "Back 5 seconds" },
  { id: "player.forward-5", keys: "right", title: "Forward 5 seconds" },
  { id: "player.volume-up", keys: "up", title: "Volume up" },
  { id: "player.volume-down", keys: "down", title: "Volume down" },
  { id: "player.fullscreen", keys: "f", title: "Full screen" },
  { id: "player.mute", keys: "m", title: "Mute" },
  { id: "player.subtitles", keys: "c", title: "Subtitles" },
  { id: "player.subtitles-earlier", keys: "g", title: "Subtitles earlier" },
  { id: "player.subtitles-later", keys: "h", title: "Subtitles later" },
  { id: "player.exit", keys: "escape", title: "Leave playback" },
] as const satisfies ReadonlyArray<KeymapEntry<string> & { readonly title: string }>;

/** The id of a player shortcut. */
export type PlayerShortcutId = (typeof PLAYER_SHORTCUTS)[number]["id"];

/** The player's shortcut registry resolved for this browser's keyboard. */
export const playerKeymap = createKeymap<PlayerShortcutId>(PLAYER_SHORTCUTS, platform);

/** A shortcut written as one label, such as `⌘K` on Apple devices or `Ctrl K` elsewhere. */
export const shortcutLabel = (id: ShortcutId): string =>
  keymap.keycaps(id).join(platform === "mac" ? "" : " ");

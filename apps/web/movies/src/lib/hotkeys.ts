import { COMMAND_MENU_KEYS } from "@media/ui/lib/command-menu";
import { defineAppHotkeys } from "@tanstack/react-hotkeys";

const GLOBAL = "Global";

const PLAYER = "Player";

/** Every keyboard shortcut in the movies web app, by action id. */
export const HOTKEYS = defineAppHotkeys({
  ...COMMAND_MENU_KEYS,
  "command-menu.toggle": {
    hotkey: "Mod+K",
    meta: { name: "Search or jump to…", group: GLOBAL },
  },
  "search.open": { hotkey: "/", meta: { name: "Search", group: GLOBAL } },
  "go.home": { hotkey: ["G", "H"], meta: { name: "Home", group: GLOBAL } },
  "go.movies": { hotkey: ["G", "M"], meta: { name: "Movies", group: GLOBAL } },
  "go.shows": { hotkey: ["G", "S"], meta: { name: "Shows", group: GLOBAL } },
  "go.my-list": { hotkey: ["G", "L"], meta: { name: "My List", group: GLOBAL } },
  "go.settings": { hotkey: ["G", ","], meta: { name: "Settings", group: GLOBAL } },
  "rows.next": { hotkey: "J", meta: { name: "Next row", group: GLOBAL } },
  "rows.previous": { hotkey: "K", meta: { name: "Previous row", group: GLOBAL } },
  "player.toggle": { hotkey: "Space", meta: { name: "Play or pause", group: PLAYER } },
  "player.toggle-k": { hotkey: "K", meta: { name: "Play or pause", group: PLAYER } },
  "player.back-10": { hotkey: "J", meta: { name: "Back 10 seconds", group: PLAYER } },
  "player.forward-10": { hotkey: "L", meta: { name: "Forward 10 seconds", group: PLAYER } },
  "player.back-5": { hotkey: "ArrowLeft", meta: { name: "Back 5 seconds", group: PLAYER } },
  "player.forward-5": {
    hotkey: "ArrowRight",
    meta: { name: "Forward 5 seconds", group: PLAYER },
  },
  "player.volume-up": { hotkey: "ArrowUp", meta: { name: "Volume up", group: PLAYER } },
  "player.volume-down": { hotkey: "ArrowDown", meta: { name: "Volume down", group: PLAYER } },
  "player.fullscreen": { hotkey: "F", meta: { name: "Full screen", group: PLAYER } },
  "player.mute": { hotkey: "M", meta: { name: "Mute", group: PLAYER } },
  "player.subtitles": { hotkey: "C", meta: { name: "Subtitles", group: PLAYER } },
  "player.subtitles-earlier": {
    hotkey: "G",
    meta: { name: "Subtitles earlier", group: PLAYER },
  },
  "player.subtitles-later": { hotkey: "H", meta: { name: "Subtitles later", group: PLAYER } },
  "player.exit": { hotkey: "Escape", meta: { name: "Leave playback", group: PLAYER } },
});

/** The id of a shortcut in {@link HOTKEYS}. */
export type HotkeyId = keyof typeof HOTKEYS;

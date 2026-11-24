import { COMMAND_MENU_KEYS } from "@media/ui/lib/command-menu";
import { defineAppHotkeys } from "@tanstack/react-hotkeys";

const EVERYWHERE = "Everywhere";

const BROWSING = "Browsing";

const TITLE_PAGE = "Title page";

const PLAYER = "Player";

/** Every keyboard shortcut in the movies web app, by action id. */
export const HOTKEYS = defineAppHotkeys({
  ...COMMAND_MENU_KEYS,
  "command-menu.toggle": {
    hotkey: "Mod+K",
    meta: { name: "Search or jump to…", group: EVERYWHERE },
  },
  "search.open": { hotkey: "/", meta: { name: "Search", group: BROWSING } },
  "go.home": { hotkey: ["G", "H"], meta: { name: "Home", group: BROWSING } },
  "go.movies": { hotkey: ["G", "M"], meta: { name: "Movies", group: BROWSING } },
  "go.shows": { hotkey: ["G", "S"], meta: { name: "Shows", group: BROWSING } },
  "go.my-list": { hotkey: ["G", "L"], meta: { name: "My List", group: BROWSING } },
  "go.settings": { hotkey: ["G", ","], meta: { name: "Settings", group: BROWSING } },
  "rows.next": { hotkey: "J", meta: { name: "Next row", group: BROWSING } },
  "rows.previous": { hotkey: "K", meta: { name: "Previous row", group: BROWSING } },
  "title.play": { hotkey: "P", meta: { name: "Play or resume", group: TITLE_PAGE } },
  "title.play-from-start": {
    hotkey: "Shift+P",
    meta: { name: "Play from start", group: TITLE_PAGE },
  },
  "title.trailer": { hotkey: "T", meta: { name: "Watch the trailer", group: TITLE_PAGE } },
  "title.my-list": {
    hotkey: "L",
    meta: { name: "Add to or remove from My List", group: TITLE_PAGE },
  },
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

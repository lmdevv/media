import { defineAppHotkeys } from "@tanstack/react-hotkeys";

export const GLOBAL_GROUP = "Global";

const COMMAND_MENU = "Command menu";

const TRACK_MENU = "Track menu";

/**
 * Every keyboard shortcut in the web app, by action id. Components bind an entry with TanStack's
 * `useHotkey` and show it with `Keys`, so the key that runs an action and the key drawn beside it
 * come from the same declaration.
 */
export const HOTKEYS = defineAppHotkeys({
  "player.toggle": { hotkey: "Space", meta: { name: "Play or pause", group: GLOBAL_GROUP } },
  "player.seek-back": {
    hotkey: "ArrowLeft",
    meta: { name: "Seek back 10 seconds", group: GLOBAL_GROUP },
  },
  "player.seek-forward": {
    hotkey: "ArrowRight",
    meta: { name: "Seek forward 10 seconds", group: GLOBAL_GROUP },
  },
  "player.previous": {
    hotkey: "Shift+ArrowLeft",
    meta: { name: "Previous song", group: GLOBAL_GROUP },
  },
  "player.next": { hotkey: "Shift+ArrowRight", meta: { name: "Next song", group: GLOBAL_GROUP } },
  "player.like": {
    hotkey: "L",
    meta: { name: "Like or unlike the playing song", group: GLOBAL_GROUP },
  },
  "search.focus": { hotkey: "/", meta: { name: "Search", group: GLOBAL_GROUP } },
  "command-menu.toggle": {
    hotkey: "Mod+K",
    meta: { name: "Command menu: search and run any command", group: GLOBAL_GROUP },
  },
  "playlists.new": { hotkey: "N", meta: { name: "New playlist", group: GLOBAL_GROUP } },
  "devices.toggle": { hotkey: "D", meta: { name: "Play on another device", group: GLOBAL_GROUP } },
  "queue.close": { hotkey: "Escape", meta: { name: "Close the queue", group: "Queue" } },
  "command-menu.enter": {
    hotkey: "Enter",
    meta: { name: "Run the selected row's main action", group: COMMAND_MENU },
  },
  "command-menu.mod-enter": {
    hotkey: "Mod+Enter",
    meta: { name: "Run the selected row's second action", group: COMMAND_MENU },
  },
  "command-menu.shift-enter": {
    hotkey: "Shift+Enter",
    meta: { name: "Run the selected row's third action", group: COMMAND_MENU },
  },
  "command-menu.alt-enter": {
    hotkey: "Alt+Enter",
    meta: { name: "Run the selected row's fourth action", group: COMMAND_MENU },
  },
  "track-menu.play-next": {
    hotkey: "Shift+Enter",
    meta: { name: "Play the song next", group: TRACK_MENU },
  },
  "track-menu.add-to-queue": {
    hotkey: "Q",
    meta: { name: "Add the song to the queue", group: TRACK_MENU },
  },
  "track-menu.like": { hotkey: "L", meta: { name: "Like or unlike the song", group: TRACK_MENU } },
});

import { keyLabels } from "@media/ui/components/keys";
import { describe, expect, it } from "vitest";

import { HOTKEYS } from "./hotkeys";
import type { HotkeyId } from "./hotkeys";

const labels = (id: HotkeyId, platform: "mac" | "linux" = "linux") =>
  keyLabels(HOTKEYS[id].defaultHotkey, platform);

describe("HOTKEYS", () => {
  it("gives each player action its key", () => {
    const player = Object.values(HOTKEYS).filter((hotkey) => hotkey.id.startsWith("player."));

    expect(Object.fromEntries(player.map((hotkey) => [hotkey.id, labels(hotkey.id)]))).toEqual({
      "player.toggle": ["Space"],
      "player.toggle-k": ["K"],
      "player.back-10": ["J"],
      "player.forward-10": ["L"],
      "player.back-5": ["←"],
      "player.forward-5": ["→"],
      "player.volume-up": ["↑"],
      "player.volume-down": ["↓"],
      "player.fullscreen": ["F"],
      "player.mute": ["M"],
      "player.subtitles": ["C"],
      "player.subtitles-earlier": ["G"],
      "player.subtitles-later": ["H"],
      "player.exit": ["Esc"],
    });
  });

  it("goes to each section with a two-key sequence", () => {
    expect(labels("go.home")).toEqual(["G", "H"]);
    expect(labels("go.movies")).toEqual(["G", "M"]);
    expect(labels("go.shows")).toEqual(["G", "S"]);
    expect(labels("go.my-list")).toEqual(["G", "L"]);
    expect(labels("go.settings")).toEqual(["G", ","]);
  });

  it("opens the command menu with ⌘K on macOS and Ctrl K elsewhere", () => {
    expect(labels("command-menu.toggle", "mac")).toEqual(["⌘", "K"]);
    expect(labels("command-menu.toggle", "linux")).toEqual(["Ctrl", "K"]);
  });

  it("names and groups every shortcut", () => {
    for (const hotkey of Object.values(HOTKEYS)) {
      expect(hotkey.meta?.name, hotkey.id).toBeTruthy();
      expect(hotkey.meta?.group, hotkey.id).toBeTruthy();
    }
  });
});

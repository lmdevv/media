import { keyLabels } from "@media/ui/components/keys";
import { formatHotkey, parseHotkey } from "@tanstack/hotkeys";
import type { Hotkey } from "@tanstack/hotkeys";
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

const SCREEN_NAMES = ["browsing", "title page", "player", "command menu"] as const;

type Screen = (typeof SCREEN_NAMES)[number];

const SCREENS: Readonly<Record<Screen, ReadonlyArray<string>>> = {
  browsing: ["Everywhere", "Browsing"],
  "title page": ["Everywhere", "Browsing", "Title page"],
  player: ["Everywhere", "Player"],
  "command menu": ["Everywhere", "Command menu"],
};

const PLATFORMS = ["mac", "linux"] as const;

const steps = (hotkey: Hotkey, platform: (typeof PLATFORMS)[number]): ReadonlyArray<string> => {
  const parsed = parseHotkey(hotkey, platform);

  return (Array.isArray(parsed) ? parsed : [parsed]).map((chord) => formatHotkey(chord));
};

const collide = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];

  return short.every((chord, index) => chord === long[index]);
};

const collisions = (screen: Screen): ReadonlyArray<string> => {
  const groups = SCREENS[screen];
  const live = Object.values(HOTKEYS).filter((hotkey) => groups.includes(hotkey.meta?.group ?? ""));

  return PLATFORMS.flatMap((platform) =>
    live.flatMap((left, index) =>
      live
        .slice(index + 1)
        .filter((right) =>
          collide(steps(left.defaultHotkey, platform), steps(right.defaultHotkey, platform)),
        )
        .map((right) => `${platform}: ${left.id} and ${right.id}`),
    ),
  );
};

describe("shortcuts on one screen", () => {
  it("puts every shortcut on some screen", () => {
    const groups = new Set<string>(Object.values(SCREENS).flat());

    for (const hotkey of Object.values(HOTKEYS)) {
      expect(groups.has(hotkey.meta?.group ?? ""), hotkey.id).toBe(true);
    }
  });

  it.each(SCREEN_NAMES)("never share keys on the %s screen", (screen) => {
    expect(collisions(screen)).toEqual([]);
  });

  it("counts the same keys and a sequence's first key as collisions", () => {
    expect(collide(steps("G", "mac"), steps(["G", "H"], "mac"))).toBe(true);
    expect(collide(steps("Mod+K", "linux"), steps("Control+K", "linux"))).toBe(true);
    expect(collide(steps("Mod+K", "mac"), steps("Control+K", "mac"))).toBe(false);
    expect(collide(steps(["G", "H"], "mac"), steps(["G", "L"], "mac"))).toBe(false);
  });
});

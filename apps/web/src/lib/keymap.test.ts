import { chordFromEvent, stepKeymap } from "@media/ui/lib/keymap";
import type { KeyEventLike } from "@media/ui/lib/keymap";
import { describe, expect, it } from "vitest";

import { playerKeymap } from "./keymap";

const press = (key: string, modifiers: Partial<KeyEventLike> = {}) => {
  const event: KeyEventLike = {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };

  const step = stepKeymap(playerKeymap.bindings, [], chordFromEvent(event));

  return step.kind === "matched" ? step.id : null;
};

describe("playerKeymap", () => {
  it("maps the player keys to their actions", () => {
    expect(press(" ")).toBe("player.toggle");
    expect(press("k")).toBe("player.toggle-k");
    expect(press("j")).toBe("player.back-10");
    expect(press("l")).toBe("player.forward-10");
    expect(press("ArrowLeft")).toBe("player.back-5");
    expect(press("ArrowRight")).toBe("player.forward-5");
    expect(press("ArrowUp")).toBe("player.volume-up");
    expect(press("ArrowDown")).toBe("player.volume-down");
    expect(press("f")).toBe("player.fullscreen");
    expect(press("m")).toBe("player.mute");
    expect(press("c")).toBe("player.subtitles");
    expect(press("g")).toBe("player.subtitles-earlier");
    expect(press("h")).toBe("player.subtitles-later");
    expect(press("Escape")).toBe("player.exit");
  });

  it("keeps the command menu shortcut and ignores modified letters", () => {
    // Tests run outside Apple platforms, where `mod` is Control.
    expect(press("k", { ctrlKey: true })).toBe("menu.toggle");
    expect(press("f", { shiftKey: true })).toBeNull();
    expect(press("g", { shiftKey: true })).toBeNull();
    expect(press("n")).toBeNull();
  });

  it("draws keycaps for the menu", () => {
    expect(playerKeymap.keycaps("player.toggle")).toStrictEqual(["Space"]);
    expect(playerKeymap.keycaps("player.back-5")).toStrictEqual(["←"]);
  });
});

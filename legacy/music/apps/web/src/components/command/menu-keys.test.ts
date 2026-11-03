import { describe, expect, it } from "vitest";

import { MOD } from "../../lib/keys";

import { menuKeyOf, runnableAction } from "./menu-keys";
import type { ChordActions } from "./menu-keys";

const press = (
  key: string,
  modifiers: {
    readonly ctrlKey?: boolean;
    readonly altKey?: boolean;
    readonly metaKey?: boolean;
    readonly shiftKey?: boolean;
    readonly isComposing?: boolean;
  } = {},
) =>
  menuKeyOf({
    key,
    ctrlKey: modifiers.ctrlKey ?? false,
    altKey: modifiers.altKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    isComposing: modifiers.isComposing ?? false,
  });

const apple = MOD === "⌘";

const mod = apple ? { metaKey: true } : { ctrlKey: true };

const otherMod = apple ? { ctrlKey: true } : { metaKey: true };

const run = (chord: string) => ({ kind: "run", chord });

describe("menuKeyOf", () => {
  it("moves with the arrow keys", () => {
    expect(press("ArrowDown")).toEqual({ kind: "next" });
    expect(press("ArrowUp")).toEqual({ kind: "previous" });
  });

  it("moves with Ctrl+J and Ctrl+P", () => {
    expect(press("j", { ctrlKey: true })).toEqual({ kind: "next" });
    expect(press("p", { ctrlKey: true })).toEqual({ kind: "previous" });
  });

  it("leaves Ctrl+N (a new browser window) and Ctrl+K (the menu toggle) alone", () => {
    expect(press("n", { ctrlKey: true })).toBeNull();
    expect(press("k", { ctrlKey: true })).toBeNull();
  });

  it("leaves Ctrl with other modifiers, and the letters alone, to the field", () => {
    expect(press("j")).toBeNull();
    expect(press("j", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press("p", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press("p", { ctrlKey: true, altKey: true })).toBeNull();
    expect(press("p", { ctrlKey: true, metaKey: true })).toBeNull();
  });

  it("runs a chord for Enter with exactly one or no modifier", () => {
    expect(press("Enter")).toEqual(run("enter"));
    expect(press("Enter", mod)).toEqual(run("mod+enter"));
    expect(press("Enter", { shiftKey: true })).toEqual(run("shift+enter"));
    expect(press("Enter", { altKey: true })).toEqual(run("alt+enter"));
  });

  it("runs nothing for Enter with extra modifiers or the platform's other control key", () => {
    expect(press("Enter", { shiftKey: true, ctrlKey: true })).toBeNull();
    expect(press("Enter", { shiftKey: true, altKey: true })).toBeNull();
    expect(press("Enter", { ...mod, shiftKey: true })).toBeNull();
    expect(press("Enter", { ...mod, altKey: true })).toBeNull();
    expect(press("Enter", otherMod)).toBeNull();
  });

  it("leaves Enter to the field while an input method is composing text", () => {
    expect(press("Enter", { isComposing: true })).toBeNull();
    expect(press("Enter", { ...mod, isComposing: true })).toBeNull();
  });

  it("ignores other keys", () => {
    expect(press("a")).toBeNull();
    expect(press("Escape")).toBeNull();
  });
});

describe("runnableAction", () => {
  const ran: Array<string> = [];

  const open = { label: "Open", run: () => ran.push("open") };

  const actions: ChordActions = {
    enter: open,
    "mod+enter": { label: "Play", run: () => ran.push("play") },
    "shift+enter": { label: "Shuffle", disabled: true, run: () => ran.push("shuffle") },
    "alt+enter": { label: "Play next", pending: true, run: () => ran.push("next") },
  };

  it("finds the action bound to a chord", () => {
    runnableAction(actions, "enter")?.run();
    runnableAction(actions, "mod+enter")?.run();

    expect(ran).toEqual(["open", "play"]);
  });

  it("finds nothing for a chord with no action, a disabled one, or one still running", () => {
    expect(runnableAction({ enter: open }, "mod+enter")).toBeNull();
    expect(runnableAction(actions, "shift+enter")).toBeNull();
    expect(runnableAction(actions, "alt+enter")).toBeNull();
  });
});

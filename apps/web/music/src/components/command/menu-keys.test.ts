import { describe, expect, it } from "vitest";

import { runnableAction } from "./menu-keys";
import type { ChordActions } from "./menu-keys";

describe("runnableAction", () => {
  const ran: Array<string> = [];

  const open = { label: "Open", run: () => ran.push("open") };

  const actions: ChordActions = {
    "command-menu.enter": open,
    "command-menu.mod-enter": { label: "Play", run: () => ran.push("play") },
    "command-menu.shift-enter": {
      label: "Shuffle",
      disabled: true,
      run: () => ran.push("shuffle"),
    },
    "command-menu.alt-enter": { label: "Play next", pending: true, run: () => ran.push("next") },
  };

  it("finds the action bound to a chord", () => {
    runnableAction(actions, "command-menu.enter")?.run();
    runnableAction(actions, "command-menu.mod-enter")?.run();

    expect(ran).toEqual(["open", "play"]);
  });

  it("finds nothing for a chord with no action, a disabled one, or one still running", () => {
    expect(runnableAction({ "command-menu.enter": open }, "command-menu.mod-enter")).toBeNull();
    expect(runnableAction(actions, "command-menu.shift-enter")).toBeNull();
    expect(runnableAction(actions, "command-menu.alt-enter")).toBeNull();
  });
});

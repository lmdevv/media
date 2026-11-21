import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  commandMenuReducer,
  currentFrame,
  initialCommandMenuState,
  visibleCommands,
} from "./command-menu";
import type { CommandItem, CommandMenuEvent, CommandMenuState, CommandPage } from "./command-menu";

const action = (id: string, title: string, detail?: string): CommandItem =>
  detail === undefined
    ? { kind: "action", id, title, perform: () => undefined }
    : { kind: "action", id, title, detail, perform: () => undefined };

const subtitles: CommandPage = {
  id: "subtitles",
  breadcrumb: "Subtitles · Severance",
  placeholder: "Language…",
  groups: [
    {
      id: "languages",
      items: [action("off", "Off"), action("en", "English", "CC"), action("es", "Español")],
    },
  ],
};

const root: CommandPage = {
  id: "root",
  placeholder: "Search or jump to…",
  groups: [
    {
      id: "continue",
      label: "Continue watching",
      scope: "browse",
      items: [
        action("severance", "Severance", "S2:E4 · 38m left"),
        action("dune", "Dune: Part Two"),
      ],
    },
    {
      id: "titles",
      label: "Titles",
      scope: "search",
      filter: "none",
      items: [action("t1", "Severance", "Show · 2022")],
    },
    {
      id: "go",
      label: "Go to",
      items: [action("home", "Home"), action("list", "My List"), action("settings", "Settings")],
    },
    {
      id: "actions",
      label: "Actions",
      items: [{ kind: "submenu", id: "subtitles", title: "Subtitles…", page: subtitles }],
    },
  ],
  fallback: () => [action("unmatched", "Search unmatched files")],
};

const reduce = (events: ReadonlyArray<CommandMenuEvent>): CommandMenuState =>
  events.reduce(commandMenuReducer, initialCommandMenuState);

describe("visibleCommands", () => {
  it("shows browse groups before anything is typed and hides search groups", () => {
    const visible = visibleCommands(root, "");

    expect(visible.groups.map((group) => group.id)).toEqual(["continue", "go", "actions"]);
    expect(visible.groups.map((group) => group.start)).toEqual([0, 2, 5]);
    expect(visible.items).toHaveLength(6);
    expect(visible.noResults).toBe(false);
  });

  it("swaps to search groups and fuzzy-filters the rest while typing", () => {
    const visible = visibleCommands(root, "set");

    expect(visible.groups.map((group) => group.id)).toEqual(["titles", "go"]);
    expect(visible.groups.map((group) => group.start)).toEqual([0, 1]);
    expect(visible.items.map((item) => item.id)).toEqual(["t1", "settings"]);
  });

  it("offers the fallback under no results", () => {
    const visible = visibleCommands({ ...root, groups: root.groups.slice(2) }, "the brutalist");

    expect(visible.noResults).toBe(true);
    expect(visible.items.map((item) => item.id)).toEqual(["unmatched"]);
  });

  it("reports no results without a fallback", () => {
    const visible = visibleCommands(subtitles, "zzz");

    expect(visible).toEqual({ groups: [], items: [], noResults: true });
  });
});

describe("commandMenuReducer", () => {
  it("wraps the highlight in both directions", () => {
    expect(currentFrame(reduce([{ type: "move", by: -1, count: 6 }])).active).toBe(5);
    expect(
      currentFrame(
        reduce([
          { type: "edge", edge: "last", count: 6 },
          { type: "move", by: 1, count: 6 },
        ]),
      ).active,
    ).toBe(0);
  });

  it("keeps the highlight inside the list for any sequence of moves", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ by: fc.integer({ min: -3, max: 3 }), count: fc.integer({ min: 0, max: 9 }) }),
        ),
        (moves) => {
          const state = reduce(moves.map((move) => ({ type: "move", ...move })));
          const last = moves.at(-1);
          const active = currentFrame(state).active;

          expect(active).toBeGreaterThanOrEqual(0);

          if (last !== undefined) expect(active).toBeLessThan(Math.max(1, last.count));
        },
      ),
    );
  });

  it("resets the highlight when the query changes", () => {
    const state = reduce([
      { type: "move", by: 2, count: 6 },
      { type: "query", query: "se" },
    ]);

    expect(currentFrame(state)).toEqual({ query: "se", active: 0 });
  });

  it("opens nested options with a fresh query and restores the parent on back", () => {
    const opened = reduce([
      { type: "query", query: "sub" },
      { type: "move", by: 1, count: 2 },
      { type: "open", page: subtitles },
      { type: "query", query: "esp" },
    ]);

    expect(currentFrame(opened)).toMatchObject({ page: subtitles, query: "esp", active: 0 });

    const back = commandMenuReducer(opened, { type: "back" });

    expect(currentFrame(back)).toEqual({ query: "sub", active: 1 });
    expect(commandMenuReducer(back, { type: "back" })).toEqual(back);
  });

  it("returns to the initial state on reset", () => {
    expect(reduce([{ type: "open", page: subtitles }, { type: "reset" }])).toEqual(
      initialCommandMenuState,
    );
  });
});

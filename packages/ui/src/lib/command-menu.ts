import type { AppHotkeyInput, Hotkey } from "@tanstack/hotkeys";
import type { ComponentType } from "react";

import { fuzzyFilter } from "./fuzzy";

const GROUP = "Command menu";

/** The command menu's own keys, which its field runs and its footer draws. */
export const COMMAND_MENU_KEYS = {
  "command-menu.run": { hotkey: "Enter", meta: { name: "Run the highlighted row", group: GROUP } },
  "command-menu.down": {
    hotkey: "ArrowDown",
    meta: { name: "Highlight the next row", group: GROUP },
  },
  "command-menu.up": {
    hotkey: "ArrowUp",
    meta: { name: "Highlight the previous row", group: GROUP },
  },
  "command-menu.next": {
    hotkey: "Control+N",
    meta: { name: "Highlight the next row", group: GROUP },
  },
  "command-menu.previous": {
    hotkey: "Control+P",
    meta: { name: "Highlight the previous row", group: GROUP },
  },
  "command-menu.back": {
    hotkey: "Backspace",
    meta: { name: "Go back a level from an empty field", group: GROUP },
  },
  "command-menu.close": {
    hotkey: "Escape",
    meta: { name: "Go back a level, then close", group: GROUP },
  },
} as const satisfies Record<string, AppHotkeyInput>;

/** What fills the fixed 20px slot in front of a command's title; a checked row draws a check. */
export type CommandLeading =
  | { readonly kind: "icon"; readonly icon: ComponentType<{ readonly className?: string }> }
  | { readonly kind: "poster"; readonly src: string };

type CommandItemFields = {
  /** Stable within its page; used for React keys and the active option's id. */
  readonly id: string;
  readonly title: string;
  /** Muted text after the title, such as `S2:E4 · 38m left`. Also searched. */
  readonly detail?: string | undefined;
  /** Extra search words that are not shown. */
  readonly keywords?: ReadonlyArray<string> | undefined;
  readonly leading?: CommandLeading | undefined;
  /**
   * Whether the row is the current choice of a list of choices. Set it on every row of such a list
   * (true or false) and leave it out elsewhere. A checked row draws a check in place of `leading`
   * and tells assistive technology it is checked.
   */
  readonly checked?: boolean | undefined;
  /** The command's shortcut, drawn as keycaps at the right edge. Omit when it has none. */
  readonly hotkey?: Hotkey | undefined;
  /** Fraction done, from 0 to 1, of a running job this row reports, such as a library scan. */
  readonly progress?: number | undefined;
};

/** A command that runs when chosen. */
export type CommandAction = CommandItemFields & {
  readonly kind: "action";
  /**
   * Runs the command. While a returned promise is pending the row shows a spinner; the menu closes
   * when it settles unless `keepOpen` is set.
   */
  readonly perform: () => void | Promise<void>;
  readonly keepOpen?: boolean | undefined;
};

/** A command that opens a nested list of options in the same panel. */
export type CommandSubmenu = CommandItemFields & {
  readonly kind: "submenu";
  readonly page: CommandPage;
};

/** One row of the command menu. */
export type CommandItem = CommandAction | CommandSubmenu;

/** A labeled section of rows. */
export type CommandGroup = {
  readonly id: string;
  /** Small label above the rows. Omit for an unlabeled list, as nested options are drawn. */
  readonly label?: string | undefined;
  readonly items: ReadonlyArray<CommandItem>;
  /**
   * When the group shows: `browse` only before anything is typed (such as Continue watching),
   * `search` only while a query is typed (such as title results), `always` in both. Default `always`.
   */
  readonly scope?: "always" | "browse" | "search" | undefined;
  /**
   * `fuzzy` filters and ranks rows by the query; `none` shows rows as given, for results the caller
   * already searched. Default `fuzzy`.
   */
  readonly filter?: "fuzzy" | "none" | undefined;
};

/** One list the menu can show: the root, or the options a {@link CommandSubmenu} opens. */
export type CommandPage = {
  readonly id: string;
  /** Chip in front of the input naming where a nested list came from, like `Subtitles · Severance`. */
  readonly breadcrumb?: string | undefined;
  readonly placeholder: string;
  readonly groups: ReadonlyArray<CommandGroup>;
  /** Commands offered under "No results for …" when nothing matches. */
  readonly fallback?: ((query: string) => ReadonlyArray<CommandItem>) | undefined;
};

/** A group of rows the menu shows. */
type VisibleGroup = {
  readonly id: string;
  readonly label: string | undefined;
  readonly items: ReadonlyArray<CommandItem>;
  /** Where the group's first row sits in {@link VisibleCommands.items}. */
  readonly start: number;
};

/** The rows the menu shows for a page and query, grouped and flattened in display order. */
export type VisibleCommands = {
  readonly groups: ReadonlyArray<VisibleGroup>;
  /** Every visible row in display order; the active index points into this list. */
  readonly items: ReadonlyArray<CommandItem>;
  /** True when a query matched nothing; any rows are the page's fallback commands. */
  readonly noResults: boolean;
};

const searchTexts = (item: CommandItem): ReadonlyArray<string> => [
  item.title,
  item.detail ?? "",
  ...(item.keywords ?? []),
];

/** Number each group's first row by the rows before it. */
const numbered = (
  groups: ReadonlyArray<Omit<VisibleGroup, "start">>,
): ReadonlyArray<VisibleGroup> =>
  groups.map((group, at) => ({
    ...group,
    start: groups.slice(0, at).reduce((rows, before) => rows + before.items.length, 0),
  }));

/** Work out which rows a page shows for a query. */
export function visibleCommands(page: CommandPage, query: string): VisibleCommands {
  const searching = query.trim().length > 0;

  const groups = page.groups.flatMap((group) => {
    const scope = group.scope ?? "always";

    if ((scope === "browse" && searching) || (scope === "search" && !searching)) return [];

    const items =
      group.filter === "none" ? group.items : fuzzyFilter(group.items, query, searchTexts);

    return items.length === 0 ? [] : [{ id: group.id, label: group.label, items }];
  });

  if (groups.length > 0 || !searching) {
    return {
      groups: numbered(groups),
      items: groups.flatMap((group) => group.items),
      noResults: false,
    };
  }

  const fallback = page.fallback?.(query) ?? [];

  return {
    groups:
      fallback.length === 0
        ? []
        : [{ id: "fallback", label: undefined, items: fallback, start: 0 }],
    items: fallback,
    noResults: true,
  };
}

/** Where the user is in one list: what they typed and which row is highlighted. */
export type CommandFrame = { readonly query: string; readonly active: number };

/** Navigation state of the menu: the root list and the nested lists opened from it. */
export type CommandMenuState = {
  readonly root: CommandFrame;
  readonly nested: ReadonlyArray<CommandFrame & { readonly page: CommandPage }>;
};

/** Everything that changes the menu's navigation state. */
export type CommandMenuEvent =
  | { readonly type: "query"; readonly query: string }
  /** Move the highlight, wrapping around a list of `count` rows. */
  | { readonly type: "move"; readonly by: number; readonly count: number }
  /** Highlight a row directly, as the pointer does. */
  | { readonly type: "point"; readonly index: number }
  /** Highlight the first or last of `count` rows. */
  | { readonly type: "edge"; readonly edge: "first" | "last"; readonly count: number }
  | { readonly type: "open"; readonly page: CommandPage }
  | { readonly type: "back" }
  | { readonly type: "reset" };

/** The state of a freshly opened menu. */
export const initialCommandMenuState: CommandMenuState = {
  root: { query: "", active: 0 },
  nested: [],
};

const updateTop = (
  state: CommandMenuState,
  update: (frame: CommandFrame) => CommandFrame,
): CommandMenuState => {
  const top = state.nested.at(-1);

  if (top === undefined) return { ...state, root: update(state.root) };

  return { ...state, nested: [...state.nested.slice(0, -1), { ...top, ...update(top) }] };
};

/** The list currently shown: the innermost nested frame, or the root frame (which has no `page`). */
export function currentFrame(
  state: CommandMenuState,
): CommandFrame & { readonly page?: CommandPage } {
  return state.nested.at(-1) ?? state.root;
}

/** Apply one navigation event. Going back restores the parent list's query and highlight. */
export function commandMenuReducer(
  state: CommandMenuState,
  event: CommandMenuEvent,
): CommandMenuState {
  switch (event.type) {
    case "query":
      return updateTop(state, () => ({ query: event.query, active: 0 }));
    case "move":
      return updateTop(state, (frame) => ({
        ...frame,
        active:
          event.count === 0
            ? 0
            : (((Math.min(frame.active, event.count - 1) + event.by) % event.count) + event.count) %
              event.count,
      }));
    case "point":
      return updateTop(state, (frame) => ({ ...frame, active: Math.max(0, event.index) }));
    case "edge":
      return updateTop(state, (frame) => ({
        ...frame,
        active: event.edge === "first" ? 0 : Math.max(0, event.count - 1),
      }));
    case "open":
      return { ...state, nested: [...state.nested, { page: event.page, query: "", active: 0 }] };
    case "back":
      return { ...state, nested: state.nested.slice(0, -1) };
    case "reset":
      return initialCommandMenuState;
    default: {
      const unhandled: never = event;

      return unhandled;
    }
  }
}

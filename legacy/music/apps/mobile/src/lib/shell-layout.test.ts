import { describe, expect, it } from "vitest";

import {
  DESTINATIONS,
  playlistPlace,
  playlistSelection,
  popsToOpen,
  shellOf,
  sidebarSelectionOf,
} from "./shell-layout";
import type { NavigationSnapshot, Place } from "./shell-layout";

describe("shellOf", () => {
  it.each([
    ["phone", false, { sidebar: "none", inspector: "none", player: "accessory" }],
    ["phone", true, { sidebar: "none", inspector: "none", player: "accessory" }],
    ["tablet", false, { sidebar: "overlay", inspector: "sheet", player: "bar" }],
    ["tablet", true, { sidebar: "overlay", inspector: "sheet", player: "bar" }],
    ["wide", false, { sidebar: "pinned", inspector: "sheet", player: "bar" }],
    ["wide", true, { sidebar: "pinned", inspector: "pane", player: "bar" }],
  ] as const)("frames a %s window (on its side: %s)", (widthClass, landscape, shell) => {
    expect(shellOf(widthClass, landscape)).toEqual(shell);
  });
});

/** The app's state with `tab` focused and its stack holding `stack`, bottom first. */
const on = (tab: string, stack: NavigationSnapshot["routes"], index = 0): NavigationSnapshot => ({
  index: 0,
  routes: [
    {
      name: "(tabs)",
      state: {
        index,
        routes: [
          ...Array.from({ length: index }, (_, slot) => ({ name: `(other${String(slot)})` })),
          { name: tab, state: { routes: stack } },
        ],
      },
    },
  ],
});

describe("sidebarSelectionOf", () => {
  it("tells the tabs' roots apart", () => {
    expect(sidebarSelectionOf(on("(home)", [{ name: "index" }]))).toBe("home");
    expect(sidebarSelectionOf(on("(library)", [{ name: "index" }]))).toBe("library");
    expect(sidebarSelectionOf(on("(playlists)", [{ name: "index" }], 1))).toBe("playlists");
    expect(sidebarSelectionOf(on("(search)", [{ name: "index" }]))).toBe("search");
  });

  it("selects a place from the stack of any tab that holds it", () => {
    expect(sidebarSelectionOf(on("(library)", [{ name: "index" }, { name: "albums" }]))).toBe(
      "albums",
    );
    expect(sidebarSelectionOf(on("(home)", [{ name: "index" }, { name: "history" }]))).toBe(
      "history",
    );
    expect(
      sidebarSelectionOf(on("(library)", [{ name: "index" }, { name: "downloaded/songs" }])),
    ).toBe("downloaded");
  });

  it("keeps the place an album was opened from", () => {
    const stack = [{ name: "index" }, { name: "albums" }, { name: "album/[id]" }];

    expect(sidebarSelectionOf(on("(library)", stack))).toBe("albums");
    expect(sidebarSelectionOf(on("(home)", [{ name: "index" }, { name: "album/[id]" }]))).toBe(
      "home",
    );
  });

  it("selects an open playlist, under whatever was pushed on it", () => {
    const stack = [
      { name: "index" },
      { name: "playlist/[id]", params: { id: "abc" } },
      { name: "artist/[id]", params: { id: "xyz" } },
    ];

    expect(sidebarSelectionOf(on("(playlists)", stack))).toBe(playlistSelection("abc"));
  });

  it("selects nothing before the tabs mount", () => {
    expect(sidebarSelectionOf({ routes: [{ name: "player" }] })).toBeNull();
    expect(sidebarSelectionOf({ routes: [{ name: "(tabs)" }] })).toBeNull();
  });

  it("keeps the selection while something covers the tabs", () => {
    const app = on("(library)", [{ name: "index" }, { name: "songs" }]);
    const covered = { index: 1, routes: [...app.routes, { name: "player" }] };

    expect(sidebarSelectionOf(covered)).toBe("songs");
  });

  it("has a root destination for every tab", () => {
    const roots = Object.values(DESTINATIONS).filter((place) => place.routes.length === 0);

    expect(roots.map((place) => place.tab).toSorted()).toEqual([
      "(home)",
      "(library)",
      "(playlists)",
      "(search)",
    ]);
  });
});

type Stack = NavigationSnapshot["routes"];

/** The root navigator's state, as the container reports it, with `tab`'s stack holding `stack`. */
const rooted = (tab: string, stack: Stack): NavigationSnapshot => ({
  routes: [
    {
      name: "(app)",
      state: {
        routes: [
          {
            name: "(tabs)",
            state: {
              index: 0,
              routes: [
                { name: tab, state: { key: "stack", index: stack.length - 1, routes: stack } },
              ],
            },
          },
        ],
      },
    },
  ],
});

/**
 * The stack after opening `place` as the sidebar does: the pops, then a `navigate`, which by the
 * stack router's rule reuses a route only if it is the one on top, and otherwise pushes.
 */
const opened = (stack: Stack, place: Place): Stack => {
  const count = popsToOpen(rooted(place.tab, stack), place)?.count ?? 0;
  const left = stack.slice(0, stack.length - count);
  const name = place.routes[0];

  if (name === undefined || left.at(-1)?.name === name) return left;

  return [...left, place.id === undefined ? { name } : { name, params: { id: place.id } }];
};

const names = (stack: Stack) => stack.map((route) => route.name);

describe("opening a place", () => {
  const root = { name: "index" };
  const albums = { name: "albums" };
  const album = { name: "album/[id]", params: { id: "a" } };
  const otherAlbum = { name: "album/[id]", params: { id: "b" } };
  const { library, albums: albumsPlace, songs, downloaded } = DESTINATIONS;

  it("returns a tab to its root, which is then what the sidebar selects", () => {
    const stack = opened([root, albums], library);

    expect(names(stack)).toEqual(["index"]);
    expect(sidebarSelectionOf(rooted("(library)", stack))).toBe("library");
    expect(names(opened([root, albums, album, otherAlbum], library))).toEqual(["index"]);
    expect(names(opened([root], library))).toEqual(["index"]);
  });

  it("lands on one page over the root from a deep page", () => {
    const stack = opened([root, album, otherAlbum], albumsPlace);

    expect(names(stack)).toEqual(["index", "albums"]);
    expect(sidebarSelectionOf(rooted("(library)", stack))).toBe("albums");
    expect(names(opened([root, { name: songs.routes[0] }], albumsPlace))).toEqual([
      "index",
      "albums",
    ]);
  });

  it("keeps the page that is already there, popping what was pushed on it", () => {
    expect(popsToOpen(rooted("(library)", [root, albums]), albumsPlace)).toBeNull();
    expect(popsToOpen(rooted("(library)", [root, albums, album]), albumsPlace)).toEqual({
      stack: "stack",
      count: 1,
    });
    expect(names(opened([root, { name: "downloaded/index" }, album], downloaded))).toEqual([
      "index",
      "downloaded/index",
    ]);
  });

  it("tells one playlist from another", () => {
    const stack = [root, { name: "playlist/[id]", params: { id: "abc" } }, album];

    expect(popsToOpen(rooted("(playlists)", stack), playlistPlace("abc"))?.count).toBe(1);
    expect(popsToOpen(rooted("(playlists)", stack), playlistPlace("xyz"))?.count).toBe(2);

    const next = opened(stack, playlistPlace("xyz"));

    expect(sidebarSelectionOf(rooted("(playlists)", next))).toBe(playlistSelection("xyz"));
    expect(next).toHaveLength(2);
  });

  it("leaves routes preloaded past the stack's top alone", () => {
    const preloaded = {
      routes: [
        {
          name: "(tabs)",
          state: {
            routes: [
              {
                name: "(library)",
                state: { key: "stack", index: 1, routes: [root, album, otherAlbum] },
              },
            ],
          },
        },
      ],
    };

    expect(popsToOpen(preloaded, library)?.count).toBe(1);
  });

  it("has nothing to pop in a tab not yet visited", () => {
    expect(popsToOpen({ routes: [{ name: "(tabs)", state: { routes: [] } }] }, library)).toBeNull();
  });
});

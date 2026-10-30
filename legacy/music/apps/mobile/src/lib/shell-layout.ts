/**
 * The app's frame at each window size (Paper page 26, direction B), and where the iPad's sidebar
 * goes. A phone keeps the system tab bar and its mini player. From `tablet` up a sidebar replaces
 * the tabs and a player bar sits under the content; the sidebar is pinned once the window is
 * `wide`, and the Now Playing inspector becomes a pane only when the window is also on its side.
 */
import type { Href } from "expo-router";

import type { WidthClass } from "./layout";

/** What each part of the frame is at one window size. */
export interface ShellLayout {
  readonly sidebar: "none" | "overlay" | "pinned";
  readonly inspector: "none" | "sheet" | "pane";
  readonly player: "accessory" | "bar";
}

const PHONE: ShellLayout = { sidebar: "none", inspector: "none", player: "accessory" };

const TABLET: ShellLayout = { sidebar: "overlay", inspector: "sheet", player: "bar" };

const SHELLS: Readonly<
  Record<WidthClass, Readonly<Record<"portrait" | "landscape", ShellLayout>>>
> = {
  phone: { portrait: PHONE, landscape: PHONE },
  tablet: { portrait: TABLET, landscape: TABLET },
  wide: {
    portrait: { sidebar: "pinned", inspector: "sheet", player: "bar" },
    landscape: { sidebar: "pinned", inspector: "pane", player: "bar" },
  },
};

/** The frame for a window of `widthClass`, on its side or not. */
export const shellOf = (widthClass: WidthClass, landscape: boolean): ShellLayout =>
  SHELLS[widthClass][landscape ? "landscape" : "portrait"];

/** Every fixed place the sidebar opens. */
export type DestinationKey =
  | "search"
  | "home"
  | "library"
  | "albums"
  | "artists"
  | "songs"
  | "liked"
  | "downloaded"
  | "history"
  | "playlists";

/** Somewhere the sidebar opens: one page in one tab. */
export interface Place {
  readonly href: Href;
  /** The tab it opens in. */
  readonly tab: string;
  /** The routes that are this place, in whichever tab's stack; none for a tab's root. */
  readonly routes: ReadonlyArray<string>;
  /** Which page of its route, where the route takes an ID. */
  readonly id?: string;
}

/** One fixed place in the sidebar. */
export interface Destination extends Place {
  readonly key: DestinationKey;
  readonly label: string;
  /** `device` opens with no server (Downloaded, and the roots that say why they are empty). */
  readonly source: "device" | "server";
}

/** The sidebar's places, which also say which of them a navigation state selects. */
export const DESTINATIONS = {
  search: {
    key: "search",
    label: "Search",
    href: "/(app)/(tabs)/(search)",
    tab: "(search)",
    routes: [],
    source: "device",
  },
  home: {
    key: "home",
    label: "Home",
    href: "/(app)/(tabs)/(home)",
    tab: "(home)",
    routes: [],
    source: "device",
  },
  library: {
    key: "library",
    label: "Library",
    href: "/(app)/(tabs)/(library)",
    tab: "(library)",
    routes: [],
    source: "device",
  },
  albums: {
    key: "albums",
    label: "Albums",
    href: "/(app)/(tabs)/(library)/albums",
    tab: "(library)",
    routes: ["albums"],
    source: "server",
  },
  artists: {
    key: "artists",
    label: "Artists",
    href: "/(app)/(tabs)/(library)/artists",
    tab: "(library)",
    routes: ["artists"],
    source: "server",
  },
  songs: {
    key: "songs",
    label: "Songs",
    href: "/(app)/(tabs)/(library)/songs",
    tab: "(library)",
    routes: ["songs"],
    source: "server",
  },
  liked: {
    key: "liked",
    label: "Liked songs",
    href: "/(app)/(tabs)/(library)/liked",
    tab: "(library)",
    routes: ["liked"],
    source: "server",
  },
  downloaded: {
    key: "downloaded",
    label: "Downloaded",
    href: "/(app)/(tabs)/(library)/downloaded",
    tab: "(library)",
    routes: ["downloaded/index", "downloaded/songs"],
    source: "device",
  },
  history: {
    key: "history",
    label: "History",
    href: "/(app)/(tabs)/(library)/history",
    tab: "(library)",
    routes: ["history"],
    source: "server",
  },
  playlists: {
    key: "playlists",
    label: "Playlists",
    href: "/(app)/(tabs)/(playlists)",
    tab: "(playlists)",
    routes: [],
    source: "device",
  },
} as const satisfies Readonly<Record<DestinationKey, Destination>>;

/** The rows of the sidebar's Library section, in order. */
export const LIBRARY_ROWS = [
  DESTINATIONS.albums,
  DESTINATIONS.artists,
  DESTINATIONS.songs,
  DESTINATIONS.liked,
  DESTINATIONS.downloaded,
  DESTINATIONS.history,
] as const;

const ALL_DESTINATIONS: ReadonlyArray<Destination> = Object.values(DESTINATIONS);

/** What the sidebar highlights: a fixed place's key, or `playlistSelection` of a playlist's ID. */
export type SidebarSelection = DestinationKey | `playlist:${string}`;

/** The selection of the playlist with this ID. */
export const playlistSelection = (id: string): SidebarSelection => `playlist:${id}`;

/** The part of a navigator's state the selection reads. */
export interface NavigationSnapshot {
  readonly key?: string | undefined;
  readonly index?: number | undefined;
  readonly routes: ReadonlyArray<{
    readonly name: string;
    readonly params?: { readonly id?: string } | undefined;
    readonly state?: NavigationSnapshot | undefined;
  }>;
}

const PLAYLIST_ROUTE = "playlist/[id]";

/** A playlist as somewhere the sidebar opens. */
export const playlistPlace = (id: string): Place => ({
  href: { pathname: "/(app)/(tabs)/(playlists)/playlist/[id]", params: { id } },
  tab: "(playlists)",
  routes: [PLAYLIST_ROUTE],
  id,
});

/** The tabs' state, from any navigator above them. */
const tabsOf = (navigator: NavigationSnapshot): NavigationSnapshot | undefined => {
  for (const route of navigator.routes) {
    if (route.name === "(tabs)") return route.state;

    const nested = route.state === undefined ? undefined : tabsOf(route.state);

    if (nested !== undefined) return nested;
  }

  return undefined;
};

/**
 * What to pop from the stack of `place`'s tab so that opening it leaves that page alone over the
 * tab's root, or null with nothing to pop. A stack already holding the page there keeps it, and
 * its scroll, under whatever was pushed on it. Null too for a tab not yet visited: it has no stack.
 */
export const popsToOpen = (
  root: NavigationSnapshot,
  place: Place,
): { readonly stack: string; readonly count: number } | null => {
  const stack = tabsOf(root)?.routes.find((route) => route.name === place.tab)?.state;

  if (stack?.key === undefined) return null;

  const page = stack.routes[1];
  const kept = page?.name === place.routes[0] && page?.params?.id === place.id ? 2 : 1;
  const count = (stack.index ?? stack.routes.length - 1) + 1 - kept;

  return count > 0 ? { stack: stack.key, count } : null;
};

/**
 * What the sidebar highlights for the navigator that holds `(tabs)`: the top place in the focused
 * tab's stack, so an album opened from Albums keeps Albums lit, or else that tab's root. Reading
 * the state rather than the pathname tells the tabs' roots apart, which all have the path `/`, and
 * keeps the selection while Now Playing or Settings covers the tabs. Null before the tabs mount.
 */
export const sidebarSelectionOf = (app: NavigationSnapshot): SidebarSelection | null => {
  const tabs = tabsOf(app);
  const tab = tabs?.routes[tabs.index ?? 0];

  if (tab === undefined) return null;

  const stack = tab.state?.routes ?? [];

  for (const route of stack.toReversed()) {
    const id = route.params?.id;

    if (route.name === PLAYLIST_ROUTE && id !== undefined) return playlistSelection(id);

    const place = ALL_DESTINATIONS.find((destination) => destination.routes.includes(route.name));

    if (place !== undefined) return place.key;
  }

  return (
    ALL_DESTINATIONS.find(
      (destination) => destination.tab === tab.name && destination.routes.length === 0,
    )?.key ?? null
  );
};

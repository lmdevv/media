/**
 * The iPad's sidebar (page 26): the wordmark and the button that hides it, Search, Home, the
 * library's places, the playlists with their covers, and the account at the foot. The rows
 * between the search field and the account scroll when they don't fit. It holds playlists and
 * library sections, so it is drawn here: the native iPadOS sidebar can only list the tabs.
 *
 * With no server it keeps what opens anyway, and dims the places that would have nothing to show.
 */
import type { Playlist } from "@music/commands/models";
import { useRead } from "@music/sdk/react";
import { router } from "expo-router";
import { useNavigationState } from "expo-router/react-navigation";
import {
  CircleArrowDown,
  History,
  Heart,
  House,
  Music,
  PanelLeft,
  Plus,
  Search,
  SlidersHorizontal,
  SquareDot,
  User,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useUniwind } from "uniwind";

import { Artwork } from "@/components/ui/artwork";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { sidebarLine } from "@/lib/playlist-format";
import {
  DESTINATIONS,
  LIBRARY_ROWS,
  playlistPlace,
  playlistSelection,
  sidebarSelectionOf,
} from "@/lib/shell-layout";
import type { Destination, DestinationKey, Place, SidebarSelection } from "@/lib/shell-layout";
import { useServerReach } from "@/session/server-reach";

import { useOpenPlace } from "./open-place";
import { useOpenSearch } from "./top-buttons";

/** Each row's glyph; the headings have none. */
const ICONS = {
  home: House,
  albums: SquareDot,
  artists: User,
  songs: Music,
  liked: Heart,
  downloaded: CircleArrowDown,
  history: History,
} as const satisfies Partial<Record<DestinationKey, LucideIcon>>;

/** A row of the Library section or Home: glyph and label, on the accent's wash while selected. */
function PlaceRow({
  place,
  selection,
  offline,
  onSelect,
}: {
  readonly place: Destination & { readonly key: keyof typeof ICONS };
  readonly selection: SidebarSelection | null;
  readonly offline: boolean;
  readonly onSelect: (place: Place) => void;
}) {
  const selected = selection === place.key;
  const dark = useUniwind().theme === "dark";
  const dimmed = offline && place.source === "server";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={place.label}
      accessibilityState={{ selected, disabled: dimmed }}
      disabled={dimmed}
      onPress={() => onSelect(place)}
      className={`h-row flex-row items-center gap-3 rounded-md px-3 active:opacity-60 ${
        selected ? "bg-accent/12" : ""
      } ${dimmed ? "opacity-disabled" : ""}`}
    >
      <Icon
        icon={ICONS[place.key]}
        size="side"
        tone={selected || !dark ? "accent" : "default"}
        filled={selected && place.key === "home"}
      />
      <Text variant={selected ? "bodyStrong" : "body"} tone={selected ? "accent" : "default"}>
        {place.label}
      </Text>
    </Pressable>
  );
}

/** A section's heading, which opens its root, with room for a trailing action. */
function Heading({
  place,
  selection,
  onSelect,
  action,
}: {
  readonly place: Destination;
  readonly selection: SidebarSelection | null;
  readonly onSelect: (place: Place) => void;
  readonly action?: ReactNode;
}) {
  const selected = selection === place.key;

  return (
    <View className="h-ios-28 flex-row items-center justify-between pl-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={place.label}
        accessibilityState={{ selected }}
        hitSlop={8}
        onPress={() => onSelect(place)}
        className="active:opacity-60"
      >
        <Text variant="secondaryStrong" tone={selected ? "accent" : "muted"}>
          {place.label}
        </Text>
      </Pressable>
      {action}
    </View>
  );
}

/** A playlist with its cover, its name, and its size. */
function PlaylistRow({
  playlist,
  selection,
  onSelect,
}: {
  readonly playlist: Playlist;
  readonly selection: SidebarSelection | null;
  readonly onSelect: (place: Place) => void;
}) {
  const selected = selection === playlistSelection(playlist.id);
  const line = sidebarLine(playlist);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${playlist.name}, ${line}`}
      accessibilityState={{ selected }}
      onPress={() => onSelect(playlistPlace(playlist.id))}
      className={`h-hit-target flex-row items-center gap-3 rounded-md px-2 active:opacity-60 ${
        selected ? "bg-accent/12" : ""
      }`}
    >
      <Artwork
        url={playlist.artUrls[0] ?? null}
        recyclingKey={playlist.id}
        className="size-8 shrink-0 rounded-sm"
      />
      <View className="min-w-0 flex-1">
        <Text variant="sidebarRow" tone={selected ? "accent" : "default"} numberOfLines={1}>
          {playlist.name}
        </Text>
        <Text variant="caption" tone="muted" numberOfLines={1}>
          {line}
        </Text>
      </View>
    </Pressable>
  );
}

/** Who is signed in; opens Settings, and works before the server has said who. */
function AccountRow({ onDone }: { readonly onDone: () => void }) {
  const me = useRead("account.me", {});
  const name = me === undefined ? "" : (me.name ?? me.email);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Settings"
      accessibilityValue={{ text: name }}
      onPress={() => {
        onDone();
        router.push("/settings");
      }}
      className="h-hit-target flex-row items-center gap-3 px-2 active:opacity-60"
    >
      <Avatar name={name} look="solidSmall" />
      <Text numberOfLines={1} className="min-w-0 flex-1">
        {name === "" ? "Settings" : name}
      </Text>
      <Icon icon={SlidersHorizontal} size="inline" tone="muted" />
    </Pressable>
  );
}

/** The sidebar's contents. `onHide` is its own button; `onDone` runs after every choice. */
export function Sidebar({
  onHide,
  onDone,
}: {
  readonly onHide: () => void;
  readonly onDone: () => void;
}) {
  const selection = useNavigationState(sidebarSelectionOf);
  const offline = useServerReach() === "offline";
  const dark = useUniwind().theme === "dark";
  const openPlace = useOpenPlace();
  const openSearch = useOpenSearch();
  const playlists = useRead("playlists.list", {});
  const shared = useRead("playlists.shared", {});

  const go = (place: Place) => {
    onDone();
    openPlace(place);
  };

  const searching = selection === DESTINATIONS.search.key;
  const shelves = [...(playlists ?? []), ...(shared ?? [])];

  return (
    <View className="flex-1 gap-4 overflow-hidden rounded-mobile-card bg-surface px-3 py-4 dark:bg-bg">
      <View className="h-hit-target flex-row items-center justify-between pl-3">
        <Text variant="wordmark">[music]</Text>
        <IconButton
          icon={PanelLeft}
          label="Hide sidebar"
          size="side"
          tone={dark ? "muted" : "accent"}
          onPress={onHide}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search"
        accessibilityState={{ selected: searching }}
        onPress={() => {
          onDone();
          openSearch();
        }}
        className="h-row flex-row items-center gap-2 rounded-md bg-border px-3 active:opacity-60"
      >
        <Icon icon={Search} size="field" tone={searching ? "accent" : "muted"} />
        <Text tone={searching ? "accent" : "muted"}>{DESTINATIONS.search.label}</Text>
      </Pressable>
      <ScrollView className="flex-1" contentContainerClassName="gap-4" alwaysBounceVertical={false}>
        <PlaceRow place={DESTINATIONS.home} selection={selection} offline={offline} onSelect={go} />
        <View className="gap-0.5">
          <Heading place={DESTINATIONS.library} selection={selection} onSelect={go} />
          {LIBRARY_ROWS.map((place) => (
            <PlaceRow
              key={place.key}
              place={place}
              selection={selection}
              offline={offline}
              onSelect={go}
            />
          ))}
        </View>
        <View className="gap-0.5">
          <Heading
            place={DESTINATIONS.playlists}
            selection={selection}
            onSelect={go}
            action={
              offline ? null : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="New playlist"
                  hitSlop={12}
                  onPress={() => {
                    onDone();
                    router.push("/playlist/new");
                  }}
                  className="pr-3 active:opacity-60"
                >
                  <Icon icon={Plus} size="field" tone={dark ? "muted" : "accent"} />
                </Pressable>
              )
            }
          />
          {shelves.map((playlist) => (
            <PlaylistRow
              key={playlist.id}
              playlist={playlist}
              selection={selection}
              onSelect={go}
            />
          ))}
        </View>
      </ScrollView>
      <AccountRow onDone={onDone} />
    </View>
  );
}

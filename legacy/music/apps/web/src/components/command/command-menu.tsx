import { argsDecoder } from "@music/commands/codec";
import { AlbumId, ArtistId, JobId, PlaylistId } from "@music/commands/ids";
import type {
  AlbumCard as Album,
  ArtistCard as Artist,
  Job,
  Playlist,
  Track,
} from "@music/commands/models";
import { Invite } from "@music/commands/models";
import type { CommandGroup } from "@music/commands/command";
import { commands, isCommandName } from "@music/commands/registry";
import type { CommandName, MutationName } from "@music/commands/registry";
import { usePlayer, usePlayerPosition } from "@music/player/react";
import { makeMusicClient } from "@music/sdk/client";
import { useRead, useReadOnce } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { Dialog, DialogBackdrop, DialogPopup, DialogPortal } from "@music/ui/components/dialog";
import { Kbd } from "@music/ui/components/kbd";
import { Spinner } from "@music/ui/components/spinner";
import { cn } from "@music/ui/lib/utils";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { Match, Option, Result, Schema } from "effect";
import {
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  DiscIcon,
  FolderIcon,
  HeartIcon,
  HomeIcon,
  KeyRoundIcon,
  ListMusicIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShuffleIcon,
  SkipForwardIcon,
  SpeakerIcon,
  TerminalIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { toast } from "sonner";

import { ProgressBar, jobPercent } from "@/components/auth/scan-progress";
import { Artwork } from "@/components/library/artwork";
import { usePlayAlbum, usePlayArtist, usePlayTracks } from "@/components/library/cards";
import { NEXT_REPEAT, perform } from "@/components/player/controls";
import { useQueueActions } from "@/components/playlists/track-menu";
import { useUi } from "@/components/shell/ui-state";
import { describeFailure, toastFailure } from "@/lib/action";
import { formatCount, formatDuration, formatTotal, plural } from "@/lib/format";

import { ArgsForm } from "./args-form";
import type { MenuContext } from "./args-form";
import { fieldsOf, rawArgs } from "./fields";
import type { FieldSpec, FormValues } from "./fields";

/** Commands that only players send; people never run them by hand. */
const INTERNAL: ReadonlySet<CommandName> = new Set([
  "devices.heartbeat",
  "playback.report",
  "stream.url",
]);

/** Groups whose commands need something playing. */
const NEEDS_TRACK: ReadonlySet<string> = new Set([
  "playback.pause",
  "playback.resume",
  "playback.next",
  "playback.previous",
  "playback.seek",
  "playback.jump",
  "queue.remove",
  "queue.clear",
  "playback.shuffle",
  "playback.repeat",
  "playback.volume",
]);

const GROUP_ICONS: Readonly<Record<CommandGroup, LucideIcon>> = {
  library: DiscIcon,
  search: SearchIcon,
  playback: PlayIcon,
  queue: ListMusicIcon,
  playlists: ListMusicIcon,
  likes: HeartIcon,
  devices: SpeakerIcon,
  libraries: FolderIcon,
  jobs: TerminalIcon,
  keys: KeyRoundIcon,
  people: UsersIcon,
  account: UserRoundIcon,
};

type Route = NonNullable<LinkProps["to"]>;

/** Query commands open the screen that shows them. */
const SCREENS: ReadonlyArray<{
  readonly name: CommandName;
  readonly title: string;
  readonly to: Route;
  readonly icon: LucideIcon;
}> = [
  { name: "library.home", title: "Home", to: "/", icon: HomeIcon },
  { name: "search", title: "Search", to: "/search", icon: SearchIcon },
  { name: "albums.list", title: "Albums", to: "/albums", icon: DiscIcon },
  { name: "artists.list", title: "Artists", to: "/artists", icon: UserRoundIcon },
  { name: "tracks.list", title: "Songs", to: "/songs", icon: MusicIcon },
  { name: "likes.list", title: "Liked songs", to: "/liked", icon: HeartIcon },
  { name: "playlists.list", title: "Playlists", to: "/playlists", icon: ListMusicIcon },
  { name: "account.me", title: "Account settings", to: "/settings/account", icon: SettingsIcon },
  { name: "keys.list", title: "API keys", to: "/settings/keys", icon: KeyRoundIcon },
  { name: "people.list", title: "People and invites", to: "/settings/people", icon: UsersIcon },
  { name: "libraries.list", title: "Library folders", to: "/settings/libraries", icon: FolderIcon },
  { name: "jobs.list", title: "Jobs", to: "/settings/jobs", icon: TerminalIcon },
];

/** Narrows a command name to one that changes state. */
const isMutation = (name: CommandName): name is MutationName => commands[name].kind === "mutation";

/** `playlists.create` → `music playlists create`, the CLI spelling of a command. */
const cliOf = (name: CommandName): string => `music ${name.split(".").join(" ")}`;

type Item =
  | { readonly kind: "now"; readonly id: string; readonly section: string; readonly track: Track }
  | { readonly kind: "album"; readonly id: string; readonly section: string; readonly album: Album }
  | {
      readonly kind: "artist";
      readonly id: string;
      readonly section: string;
      readonly artist: Artist;
    }
  | {
      readonly kind: "track";
      readonly id: string;
      readonly section: string;
      readonly track: Track;
      readonly tracks: ReadonlyArray<Track>;
    }
  | {
      readonly kind: "playlist";
      readonly id: string;
      readonly section: string;
      readonly playlist: Playlist;
    }
  | {
      readonly kind: "command";
      readonly id: string;
      readonly section: string;
      readonly name: MutationName;
      readonly fields: ReadonlyArray<FieldSpec>;
      readonly defaults: FormValues;
    }
  | {
      readonly kind: "action";
      readonly id: string;
      readonly section: string;
      readonly title: string;
      readonly detail: string;
      readonly icon: LucideIcon;
      readonly shortcut?: string;
      readonly label: string;
      readonly run: () => void;
    };

const titleOf = (item: Item): string => {
  switch (item.kind) {
    case "now":
    case "track":
      return item.track.title;
    case "album":
      return item.album.title;
    case "artist":
      return item.artist.name;
    case "playlist":
      return item.playlist.name;
    case "command":
      return commands[item.name].summary;
    case "action":
      return item.title;
    default:
      return "";
  }
};

const keywordsOf = (item: Item): string => {
  switch (item.kind) {
    case "command":
      return `${item.name} ${commands[item.name].group} ${cliOf(item.name)}`;
    case "action":
      return item.detail;
    case "now":
    case "album":
    case "artist":
    case "track":
    case "playlist":
      return "";
  }

  return "";
};

/** Ranks how well `query` matches: whole-title prefix, then a word prefix, then anywhere. */
const score = (item: Item, query: string): number => {
  const title = titleOf(item).toLowerCase();

  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  const haystack = `${title} ${keywordsOf(item).toLowerCase()}`;

  if (!words.every((word) => haystack.includes(word))) return 0;

  if (title.startsWith(query.toLowerCase())) return 3;

  return title.split(/\s+/).some((word) => words.some((part) => word.startsWith(part))) ? 2 : 1;
};

const JobResult = Schema.Struct({ jobId: JobId });

const KeyResult = Schema.Struct({ key: Schema.String });

const PlaylistResult = Schema.Struct({ playlistId: PlaylistId });

const decodeJob = Schema.decodeUnknownOption(JobResult);

const decodeKey = Schema.decodeUnknownOption(KeyResult);

const decodeInvite = Schema.decodeUnknownOption(Invite);

const decodePlaylist = Schema.decodeUnknownOption(PlaylistResult);

const decodeAlbumId = Schema.decodeUnknownOption(AlbumId);

const decodeArtistId = Schema.decodeUnknownOption(ArtistId);

const decodePlaylistId = Schema.decodeUnknownOption(PlaylistId);

/** What the screen behind the menu shows, from the current route's parameters. */
const useMenuContext = (): MenuContext => {
  const params = useParams({ strict: false });

  return {
    albumId: Option.getOrNull(decodeAlbumId(params.albumId)),
    artistId: Option.getOrNull(decodeArtistId(params.artistId)),
    playlistId: Option.getOrNull(decodePlaylistId(params.playlistId)),
  };
};

/** Default form values from what is playing and on screen. */
const useDefaults = (): ((name: MutationName, fields: ReadonlyArray<FieldSpec>) => FormValues) => {
  const player = usePlayer();
  const position = usePlayerPosition();
  const me = useRead("account.me", {});

  return (name, fields) => {
    const values: Record<string, FormValues[string]> = {};

    for (const field of fields) {
      if (field.field.kind === "boolean" && !field.optional) values[field.name] = false;
    }

    const track = player.track;

    const extra: FormValues = Match.value(name).pipe(
      Match.when("likes.set", () =>
        track === null ? {} : { trackId: track.id, liked: !track.liked },
      ),
      Match.when("playback.shuffle", () => ({ on: !player.shuffle })),
      Match.when("playback.repeat", () => ({ mode: NEXT_REPEAT[player.repeat] })),
      Match.when("playback.volume", () => ({ volume: String(player.volume) })),
      Match.when("playback.seek", () => ({ positionMs: String(Math.round(position)) })),
      Match.when("playback.jump", () => ({ index: String(player.index) })),
      Match.when("account.rename", () => ({ name: me?.name ?? undefined })),
      Match.whenOr("queue.add", "playback.play", "playlists.add", () =>
        track === null ? {} : { trackIds: [track.id] },
      ),
      Match.orElse(() => ({})),
    );

    return { ...values, ...extra };
  };
};

/** The outcome shown in the preview after a command that has one worth showing. */
type Outcome =
  | { readonly kind: "job"; readonly jobId: JobId; readonly title: string }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "invite"; readonly link: string };

/**
 * The ⌘K command menu (Paper page 08): search your library and run any command from the registry
 * that applies here, with a preview pane and an inline form for commands that take arguments.
 */
export function CommandMenu() {
  const { commandOpen, setCommandOpen } = useUi();

  return (
    <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          aria-label="Command menu"
          className="fixed inset-x-2 top-2 z-50 flex max-h-[calc(100dvh-16px)] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised text-text shadow-[0_1px_2px_rgb(0_0_0/4%),0_24px_64px_rgb(0_0_0/16%)] outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 lg:inset-x-auto lg:top-[110px] lg:left-1/2 lg:w-[780px] lg:-translate-x-1/2"
        >
          {commandOpen ? <Menu onClose={() => setCommandOpen(false)} /> : null}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

function Menu({ onClose }: { readonly onClose: () => void }) {
  const player = usePlayer();
  const ui = useUi();
  const navigate = useNavigate();
  const context = useMenuContext();
  const defaults = useDefaults();
  const me = useRead("account.me", {});
  const home = useRead("library.home", {});
  const playlists = useRead("playlists.list", {});
  const readLikes = useReadOnce("likes.list");
  const playTracks = usePlayTracks();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const search = useRead("search", deferred.length === 0 ? "skip" : { query: deferred, limit: 6 });
  const [lastSearch, setLastSearch] = useState(search);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const admin = me?.role === "admin";

  useEffect(() => {
    if (search !== undefined) setLastSearch(search);
  }, [search]);

  // The menu exists to type into, so focus starts in the field.
  useEffect(() => {
    input.current?.focus();
  }, []);

  const actions = useMemo((): ReadonlyArray<Item> => {
    const go = (to: Route) => () => {
      onClose();
      void navigate({ to });
    };

    const quick: Array<Item> = [
      {
        kind: "action",
        id: "shuffle-liked",
        section: "Commands",
        title: "Shuffle liked songs",
        detail: "Play your liked songs in random order",
        icon: HeartIcon,
        label: "Shuffle",
        run: () => {
          onClose();
          void (async () => {
            try {
              const tracks = await readLikes({});

              if (tracks.length === 0) toast("You haven't liked any songs yet.");
              else await playTracks(tracks, { shuffle: true });
            } catch (cause) {
              toastFailure(cause);
            }
          })();
        },
      },
      {
        kind: "action",
        id: "devices",
        section: "Commands",
        title: "Play on another device…",
        detail: "Move playback to your phone, another browser, or a speaker",
        icon: SpeakerIcon,
        shortcut: "D",
        label: "Choose",
        run: () => {
          onClose();
          ui.setDevicesOpen(true);
        },
      },
      {
        kind: "action",
        id: "new-playlist",
        section: "Commands",
        title: "New playlist",
        detail: "Create a playlist, empty or from the queue or liked songs",
        icon: PlusIcon,
        shortcut: "N",
        label: "Create",
        run: () => {
          onClose();
          ui.openNewPlaylist();
        },
      },
    ];

    if (player.track !== null) {
      quick.push({
        kind: "action",
        id: "open-queue",
        section: "Commands",
        title: "Open the queue",
        detail: "See and change what plays next",
        icon: ListMusicIcon,
        label: "Open",
        run: () => {
          onClose();
          ui.setNowPlaying("queue");
        },
      });
    }

    const screens = SCREENS.flatMap((screen): ReadonlyArray<Item> =>
      admin || commands[screen.name].access === "user"
        ? [
            {
              kind: "action",
              id: `go-${screen.name}`,
              section: "Go to",
              title: screen.title,
              detail: `Open ${screen.title} · ${cliOf(screen.name)}`,
              icon: screen.icon,
              label: "Open",
              run: go(screen.to),
            },
          ]
        : [],
    );

    const registry = Object.keys(commands)
      .filter(isCommandName)
      .filter(isMutation)
      .flatMap((name): ReadonlyArray<Item> => {
        const command = commands[name];

        if (INTERNAL.has(name)) return [];

        if (command.access === "admin" && !admin) return [];

        if (player.track === null && NEEDS_TRACK.has(name)) return [];

        const fields = fieldsOf(name);

        if (fields === null) return [];

        return [
          {
            kind: "command",
            id: `cmd-${name}`,
            section: "Commands",
            name,
            fields,
            defaults: defaults(name, fields),
          },
        ];
      });

    return [...quick, ...registry, ...screens];
  }, [admin, defaults, navigate, onClose, player.track, playTracks, readLikes, ui]);

  const items = useMemo((): ReadonlyArray<Item> => {
    if (deferred.length === 0) {
      const now: Array<Item> =
        player.track === null
          ? []
          : [{ kind: "now", id: "now", section: "Now playing", track: player.track }];

      const recent: Array<Item> = [
        ...(playlists ?? []).slice(0, 2).map((playlist): Item => ({
          kind: "playlist",
          id: `pl-${playlist.id}`,
          section: "Recent",
          playlist,
        })),
        ...(home?.recentlyPlayed ?? []).slice(0, 2).map((album): Item => ({
          kind: "album",
          id: `al-${album.id}`,
          section: "Recent",
          album,
        })),
      ];

      return [...now, ...recent, ...actions];
    }

    const results = lastSearch;

    const library: Array<Item> =
      results === undefined
        ? []
        : [
            ...results.artists.slice(0, 2).map((artist): Item => ({
              kind: "artist",
              id: `ar-${artist.id}`,
              section: "Top results",
              artist,
            })),
            ...results.albums.slice(0, 3).map((album): Item => ({
              kind: "album",
              id: `al-${album.id}`,
              section: "Top results",
              album,
            })),
            ...results.tracks.slice(0, 4).map((track): Item => ({
              kind: "track",
              id: `tr-${track.id}`,
              section: "Top results",
              track,
              tracks: results.tracks,
            })),
            ...(playlists ?? [])
              .filter((playlist) => playlist.name.toLowerCase().includes(deferred.toLowerCase()))
              .slice(0, 2)
              .map((playlist): Item => ({
                kind: "playlist",
                id: `pl-${playlist.id}`,
                section: "Top results",
                playlist,
              })),
          ];

    const matched = actions
      .map((item) => ({ item, rank: score(item, deferred) }))
      .filter((entry) => entry.rank > 0)
      .toSorted((left, right) => right.rank - left.rank)
      .map((entry) => entry.item);

    return [...library, ...matched];
  }, [deferred, player.track, playlists, home, actions, lastSearch]);

  const searching = deferred.length > 0 && search === undefined;

  useEffect(() => {
    setActiveId(null);
    setDetail(false);
  }, [deferred]);

  // Once results for the query settle, the selection follows its item, so results arriving later
  // never move what Enter runs.
  useEffect(() => {
    const [first] = items;

    if (activeId === null && !searching && first !== undefined) setActiveId(first.id);
  }, [activeId, items, searching]);

  const active = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );

  const current = items[active];
  const select = (index: number) => setActiveId(items[index]?.id ?? null);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const [runPrimary, setRunPrimary] = useState<(() => void) | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Ctrl+N and Ctrl+P move like the arrows, as in Emacs, fzf, and most terminal pickers.
    const ctrl = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;

    if (event.key === "ArrowDown" || (ctrl && event.key === "n")) {
      event.preventDefault();
      select(Math.min(active + 1, items.length - 1));
    } else if (event.key === "ArrowUp" || (ctrl && event.key === "p")) {
      event.preventDefault();
      select(Math.max(active - 1, 0));
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      runPrimary?.();
    }
  };

  const empty = items.length === 0 && !searching;

  return (
    <>
      <div className="flex h-[60px] shrink-0 items-center gap-3 border-b border-border px-5">
        {searching ? (
          <Spinner className="size-5 text-text-muted" label="Searching" />
        ) : (
          <SearchIcon aria-hidden className="size-5 shrink-0 text-text-muted" />
        )}
        <input
          ref={input}
          aria-label="Search your library or type a command"
          aria-activedescendant={current === undefined ? undefined : `command-${current.id}`}
          aria-controls="command-list"
          role="combobox"
          aria-expanded
          placeholder="Search your library or type a command…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 grow bg-transparent font-sans text-lg/md text-text outline-none placeholder:text-text-muted"
        />
        <button type="button" onClick={onClose} className="shrink-0" aria-label="Close">
          <Kbd>ESC</Kbd>
        </button>
      </div>

      {empty ? (
        <div className="flex h-[280px] flex-col items-center justify-center gap-2.5 p-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-surface">
            <SearchIcon aria-hidden className="size-[22px] text-text-muted" />
          </span>
          <span className="font-sans text-md/base font-semibold text-text">
            Nothing matches “{deferred}”
          </span>
          <span className="max-w-[380px] font-sans text-sm/xs text-text-muted">
            It isn't in your library or the command list. Try fewer words.
          </span>
        </div>
      ) : (
        <div className="flex min-h-0 grow lg:h-[440px] lg:grow-0">
          <div
            ref={list}
            id="command-list"
            role="listbox"
            aria-label="Results and commands"
            className={cn(
              "flex w-full shrink-0 flex-col gap-px overflow-y-auto p-2 lg:w-[360px] lg:border-r lg:border-border",
              detail && "max-lg:hidden",
            )}
          >
            {items.map((item, index) => (
              <ItemRow
                key={item.id}
                item={item}
                index={index}
                active={index === active}
                header={
                  index === 0 || items[index - 1]?.section !== item.section ? item.section : null
                }
                onHover={() => select(index)}
                onSelect={() => {
                  select(index);

                  if (item.kind === "command" && item.fields.length > 0) setDetail(true);
                  else if (item.kind === "now") setDetail(true);
                  else runPrimary?.();
                }}
              />
            ))}
          </div>
          <div
            className={cn(
              "min-w-0 grow overflow-y-auto",
              detail ? "flex" : "max-lg:hidden lg:flex",
            )}
          >
            {current === undefined ? null : (
              <Preview
                key={current.id}
                item={current}
                context={context}
                onClose={onClose}
                onBack={() => setDetail(false)}
                registerPrimary={setRunPrimary}
              />
            )}
          </div>
        </div>
      )}

      <div className="hidden h-11 shrink-0 items-center gap-3.5 border-t border-border bg-surface pr-3 pl-5 lg:flex">
        <span className="grow font-mono text-xs/xs font-semibold text-text-muted">[music]</span>
        {current === undefined ? null : (
          <span className="flex items-center gap-2 font-sans text-sm/xs font-medium text-text">
            {primaryLabel(current, player.status === "playing")}
            <Kbd>↵</Kbd>
          </span>
        )}
        <span aria-hidden className="h-4 w-px bg-border" />
        <span className="flex items-center gap-2 font-sans text-sm/xs text-text-muted">
          Close
          <Kbd>ESC</Kbd>
        </span>
      </div>
    </>
  );
}

const primaryLabel = (item: Item, playing: boolean): string => {
  switch (item.kind) {
    case "now":
      return playing ? "Pause" : "Resume";
    case "album":
      return "Play album";
    case "artist":
      return "Play artist";
    case "track":
      return "Play";
    case "playlist":
      return "Open playlist";
    case "command":
      return "Run";
    case "action":
      return item.label;
    default:
      return "Open";
  }
};

function Thumb({ item }: { readonly item: Item }) {
  switch (item.kind) {
    case "now":
    case "track":
      return (
        <Artwork
          url={item.track.artUrl}
          seed={item.track.albumId}
          className="size-8 rounded-[4px]"
        />
      );
    case "album":
      return (
        <Artwork url={item.album.artUrl} seed={item.album.id} className="size-8 rounded-[4px]" />
      );
    case "artist":
      return <Artwork url={item.artist.artUrl} seed={item.artist.id} round className="size-8" />;
    case "playlist":
      return (
        <Artwork
          url={item.playlist.artUrls[0] ?? null}
          seed={item.playlist.id}
          className="size-8 rounded-[4px]"
        />
      );
    case "command": {
      const Icon = GROUP_ICONS[commands[item.name].group];

      return (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface">
          <Icon aria-hidden className="size-4" />
        </span>
      );
    }

    case "action":
      return (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface">
          <item.icon aria-hidden className="size-4" />
        </span>
      );
    default:
      return null;
  }
}

function ItemRow({
  item,
  index,
  active,
  header,
  onHover,
  onSelect,
}: {
  readonly item: Item;
  readonly index: number;
  readonly active: boolean;
  readonly header: string | null;
  readonly onHover: () => void;
  readonly onSelect: () => void;
}) {
  const player = usePlayer();
  const position = usePlayerPosition();

  const subtitle = ((): string | null => {
    switch (item.kind) {
      case "now":
        return `${player.status === "playing" ? "Playing" : "Paused"} at ${formatDuration(position)} · ${item.track.artist}`;
      case "album":
        return `Album · ${item.album.artist}${item.album.year === null ? "" : ` · ${item.album.year}`}`;
      case "artist":
        return `Artist · ${plural(item.artist.albumCount, "album")}`;
      case "track":
        return `Song · ${item.track.album} · ${formatDuration(item.track.durationMs)}`;
      case "playlist":
        return `Playlist · ${plural(item.playlist.trackCount, "song")}`;
      case "command":
        return cliOf(item.name);
      case "action":
        return null;
    }

    return null;
  })();

  return (
    <>
      {header === null ? null : (
        <span
          className={cn(
            "px-2.5 pb-1.5 font-sans text-xs/xs font-semibold text-text-muted",
            index === 0 ? "pt-2" : "pt-3",
          )}
        >
          {header}
        </span>
      )}
      <div
        id={`command-${item.id}`}
        role="option"
        aria-selected={active}
        data-index={index}
        tabIndex={-1}
        onMouseMove={onHover}
        onClick={onSelect}
        className={cn(
          "flex shrink-0 cursor-pointer items-center gap-3 rounded-md px-2.5",
          subtitle === null ? "h-11" : "h-12",
          active && "bg-surface",
        )}
      >
        <Thumb item={item} />
        <span className="flex min-w-0 grow flex-col gap-px">
          <span
            className={cn(
              "truncate font-sans text-base/sm text-text",
              subtitle !== null && "font-medium",
            )}
          >
            {titleOf(item)}
          </span>
          {subtitle === null ? null : (
            <span className="truncate font-sans text-xs/xs text-text-muted">{subtitle}</span>
          )}
        </span>
        {item.kind === "action" && item.shortcut !== undefined ? (
          <span className="shrink-0 font-mono text-[11px] leading-[14px] text-text-muted">
            {item.shortcut}
          </span>
        ) : active ? (
          <span className="shrink-0 font-mono text-[11px] leading-[14px] text-text-muted">↵</span>
        ) : null}
      </div>
    </>
  );
}

const previewArt = "size-[148px] rounded-md shadow-[0_12px_32px_rgb(0_0_0/22%)]";

function PreviewFrame({
  children,
  tint,
  onBack,
}: {
  readonly children: ReactNode;
  readonly tint?: string | undefined;
  readonly onBack: () => void;
}) {
  return (
    <div
      className="flex w-full flex-col gap-4 p-6"
      style={
        tint === undefined
          ? undefined
          : {
              backgroundImage: `linear-gradient(in oklab 180deg, color-mix(in oklab, ${tint} 10%, transparent) 0%, transparent 60%)`,
            }
      }
    >
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 font-sans text-sm/xs font-medium text-text-muted lg:hidden"
      >
        <ArrowLeftIcon className="size-4" />
        Back
      </button>
      {children}
    </div>
  );
}

function PreviewTitle({ title, meta }: { readonly title: string; readonly meta: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="font-sans text-xl/xl font-heavy tracking-tight text-text">{title}</h2>
      <span className="font-sans text-base/sm text-text-muted">{meta}</span>
    </div>
  );
}

function Preview({
  item,
  context,
  onClose,
  onBack,
  registerPrimary,
}: {
  readonly item: Item;
  readonly context: MenuContext;
  readonly onClose: () => void;
  readonly onBack: () => void;
  readonly registerPrimary: (run: (() => void) | null) => void;
}) {
  switch (item.kind) {
    case "now":
      return (
        <NowPreview
          track={item.track}
          onClose={onClose}
          onBack={onBack}
          registerPrimary={registerPrimary}
        />
      );
    case "album":
      return (
        <AlbumPreview
          album={item.album}
          onClose={onClose}
          onBack={onBack}
          registerPrimary={registerPrimary}
        />
      );
    case "artist":
      return (
        <ArtistPreview
          artist={item.artist}
          onClose={onClose}
          onBack={onBack}
          registerPrimary={registerPrimary}
        />
      );
    case "track":
      return (
        <TrackPreview
          track={item.track}
          tracks={item.tracks}
          onClose={onClose}
          onBack={onBack}
          registerPrimary={registerPrimary}
        />
      );
    case "playlist":
      return (
        <PlaylistPreview
          playlist={item.playlist}
          onClose={onClose}
          onBack={onBack}
          registerPrimary={registerPrimary}
        />
      );
    case "command":
      return (
        <CommandPreview
          name={item.name}
          fields={item.fields}
          defaults={item.defaults}
          context={context}
          onClose={onClose}
          onBack={onBack}
          registerPrimary={registerPrimary}
        />
      );
    case "action":
      return <ActionPreview item={item} onBack={onBack} registerPrimary={registerPrimary} />;
    default:
      return null;
  }
}

interface PreviewProps {
  readonly onClose: () => void;
  readonly onBack: () => void;
  readonly registerPrimary: (run: (() => void) | null) => void;
}

/** Registers the preview's primary action for Enter and the footer while it is shown. */
const usePrimary = (registerPrimary: PreviewProps["registerPrimary"], run: () => void): void => {
  const latest = useRef(run);

  latest.current = run;

  useEffect(() => {
    registerPrimary(() => () => latest.current());

    return () => registerPrimary(null);
  }, [registerPrimary]);
};

function NowPreview({
  track,
  onClose,
  onBack,
  registerPrimary,
}: PreviewProps & { readonly track: Track }) {
  const player = usePlayer();
  const position = usePlayerPosition();
  const ui = useUi();
  const playing = player.status === "playing";
  const upNext = player.queue.slice(player.index + 1, player.index + 4);

  usePrimary(registerPrimary, () => perform(player.togglePlay()));

  return (
    <PreviewFrame onBack={onBack}>
      <Artwork url={track.artUrl} seed={track.albumId} className={previewArt} />
      <PreviewTitle title={track.title} meta={`${track.artist} · ${track.album}`} />
      <div className="flex flex-col gap-1.5">
        <ProgressBar
          percent={Math.min(100, (position / Math.max(1, player.durationMs)) * 100)}
          label="Position"
          className="h-1 [&>div]:bg-text"
        />
        <div className="flex justify-between font-mono text-xs/xs text-text-muted">
          <span>{formatDuration(position)}</span>
          <span>{formatDuration(player.durationMs)}</span>
        </div>
      </div>
      {upNext.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <span className="font-sans text-xs/xs font-semibold text-text-muted">Up next</span>
          <span className="font-sans text-sm/xs text-text">
            {upNext.map((next) => next.title).join(" · ")}
          </span>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant="solid"
          size="sm"
          className="pl-3"
          onClick={() => perform(player.togglePlay())}
        >
          {playing ? (
            <PauseIcon fill="currentColor" strokeWidth={0} />
          ) : (
            <PlayIcon fill="currentColor" strokeWidth={0} />
          )}
          {playing ? "Pause" : "Resume"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onClose();
            ui.setNowPlaying("queue");
          }}
        >
          Open queue
        </Button>
      </div>
    </PreviewFrame>
  );
}

function AlbumPreview({
  album,
  onClose,
  onBack,
  registerPrimary,
}: PreviewProps & { readonly album: Album }) {
  const detail = useRead("albums.get", { albumId: album.id });
  const playAlbum = usePlayAlbum();
  const navigate = useNavigate();
  const { playNext } = useQueueActions();

  const play = (shuffle: boolean) => {
    onClose();
    void playAlbum(album.id, shuffle);
  };

  usePrimary(registerPrimary, () => play(false));

  return (
    <PreviewFrame onBack={onBack}>
      <button
        type="button"
        onClick={() => {
          onClose();
          void navigate({ to: "/albums/$albumId", params: { albumId: album.id } });
        }}
        className="w-fit"
        aria-label={`Open ${album.title}`}
      >
        <Artwork url={album.artUrl} seed={album.id} className={previewArt} />
      </button>
      <PreviewTitle
        title={album.title}
        meta={[
          album.artist,
          album.year,
          plural(album.trackCount, "song"),
          detail === undefined ? null : formatTotal(detail.durationMs),
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      />
      {detail === undefined ? null : (
        <div className="flex flex-col">
          {detail.tracks.slice(0, 3).map((track, index) => (
            <div
              key={track.id}
              className="flex h-[30px] items-center gap-2.5 border-t border-border"
            >
              <span className="w-4 shrink-0 font-mono text-xs/xs text-text-muted">
                {track.trackNumber ?? index + 1}
              </span>
              <span className="grow truncate font-sans text-sm/xs text-text">{track.title}</span>
              <span className="font-mono text-xs/xs text-text-muted">
                {formatDuration(track.durationMs)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="solid" size="sm" className="pl-3" onClick={() => play(false)}>
          <PlayIcon fill="currentColor" strokeWidth={0} />
          Play
        </Button>
        <Button variant="secondary" size="sm" onClick={() => play(true)}>
          Shuffle
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={detail === undefined}
          onClick={() => detail !== undefined && playNext(detail.tracks)}
        >
          Play next
        </Button>
      </div>
    </PreviewFrame>
  );
}

function ArtistPreview({
  artist,
  onClose,
  onBack,
  registerPrimary,
}: PreviewProps & { readonly artist: Artist }) {
  const playArtist = usePlayArtist();
  const navigate = useNavigate();

  usePrimary(registerPrimary, () => {
    onClose();
    void playArtist(artist.id);
  });

  return (
    <PreviewFrame onBack={onBack}>
      <Artwork url={artist.artUrl} seed={artist.id} round className="size-[148px]" />
      <PreviewTitle title={artist.name} meta={`Artist · ${plural(artist.albumCount, "album")}`} />
      <div className="flex gap-2">
        <Button
          variant="solid"
          size="sm"
          className="pl-3"
          onClick={() => {
            onClose();
            void playArtist(artist.id);
          }}
        >
          <PlayIcon fill="currentColor" strokeWidth={0} />
          Play
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onClose();
            void playArtist(artist.id, true);
          }}
        >
          <ShuffleIcon />
          Shuffle
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onClose();
            void navigate({ to: "/artists/$artistId", params: { artistId: artist.id } });
          }}
        >
          Open
        </Button>
      </div>
    </PreviewFrame>
  );
}

function TrackPreview({
  track,
  tracks,
  onClose,
  onBack,
  registerPrimary,
}: PreviewProps & { readonly track: Track; readonly tracks: ReadonlyArray<Track> }) {
  const play = usePlayTracks();
  const { playNext, addToQueue } = useQueueActions();

  const start = () => {
    onClose();
    void play(tracks, { index: Math.max(0, tracks.indexOf(track)) });
  };

  usePrimary(registerPrimary, start);

  return (
    <PreviewFrame onBack={onBack}>
      <Artwork url={track.artUrl} seed={track.albumId} className={previewArt} />
      <PreviewTitle
        title={track.title}
        meta={`${track.artist} · ${track.album} · ${formatDuration(track.durationMs)}`}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="solid" size="sm" className="pl-3" onClick={start}>
          <PlayIcon fill="currentColor" strokeWidth={0} />
          Play
        </Button>
        <Button variant="secondary" size="sm" onClick={() => playNext([track])}>
          <SkipForwardIcon />
          Play next
        </Button>
        <Button variant="secondary" size="sm" onClick={() => addToQueue([track])}>
          Add to queue
        </Button>
      </div>
    </PreviewFrame>
  );
}

function PlaylistPreview({
  playlist,
  onClose,
  onBack,
  registerPrimary,
}: PreviewProps & { readonly playlist: Playlist }) {
  const navigate = useNavigate();
  const detail = useRead("playlists.get", { playlistId: playlist.id });
  const play = usePlayTracks();

  const open = () => {
    onClose();
    void navigate({ to: "/playlists/$playlistId", params: { playlistId: playlist.id } });
  };

  usePrimary(registerPrimary, open);

  return (
    <PreviewFrame onBack={onBack}>
      <Artwork url={playlist.artUrls[0] ?? null} seed={playlist.id} className={previewArt} />
      <PreviewTitle
        title={playlist.name}
        meta={`Playlist · ${plural(playlist.trackCount, "song")}${playlist.trackCount > 0 ? ` · ${formatTotal(playlist.durationMs)}` : ""}`}
      />
      <div className="flex gap-2">
        <Button
          variant="solid"
          size="sm"
          className="pl-3"
          disabled={detail === undefined || detail.items.length === 0}
          onClick={() => {
            onClose();
            void play(detail?.items.map((item) => item.track) ?? []);
          }}
        >
          <PlayIcon fill="currentColor" strokeWidth={0} />
          Play
        </Button>
        <Button variant="secondary" size="sm" onClick={open}>
          Open playlist
        </Button>
      </div>
    </PreviewFrame>
  );
}

function ActionPreview({
  item,
  onBack,
  registerPrimary,
}: Omit<PreviewProps, "onClose"> & { readonly item: Extract<Item, { kind: "action" }> }) {
  usePrimary(registerPrimary, item.run);

  return (
    <PreviewFrame onBack={onBack}>
      <span className="flex size-12 items-center justify-center rounded-lg bg-surface">
        <item.icon aria-hidden className="size-6" />
      </span>
      <PreviewTitle title={item.title} meta={item.detail} />
      <div className="flex gap-2">
        <Button variant="solid" size="sm" onClick={item.run}>
          {item.label}
        </Button>
      </div>
    </PreviewFrame>
  );
}

function CommandPreview({
  name,
  fields,
  defaults,
  context,
  onClose,
  onBack,
  registerPrimary,
}: PreviewProps & {
  readonly name: MutationName;
  readonly fields: ReadonlyArray<FieldSpec>;
  readonly defaults: FormValues;
  readonly context: MenuContext;
}) {
  const convex = useConvex();
  const client = useMemo(() => makeMusicClient(convex), [convex]);
  const navigate = useNavigate();
  // Only fields the person changed are kept; the rest follow live defaults such as the current song.
  const [edits, setEdits] = useState<FormValues>({});
  const values: FormValues = { ...defaults, ...edits };
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const command = commands[name];

  const run = async () => {
    const decoded = argsDecoder(name)(rawArgs(fields, values));

    if (Result.isFailure(decoded)) {
      setError(`Check the fields: ${decoded.failure.message}`);

      return;
    }

    setPending(true);
    setError(null);

    try {
      const result = await client.run(name, decoded.success);
      const job = decodeJob(result);
      const key = decodeKey(result);
      const invite = decodeInvite(result);
      const playlist = decodePlaylist(result);

      if (Option.isSome(job)) {
        setOutcome({ kind: "job", jobId: job.value.jobId, title: command.summary });
      } else if (Option.isSome(key)) {
        setOutcome({ kind: "key", key: key.value.key });
      } else if (Option.isSome(invite)) {
        setOutcome({
          kind: "invite",
          link: `${window.location.origin}/invite/${invite.value.code}`,
        });
      } else if (Option.isSome(playlist)) {
        onClose();
        await navigate({
          to: "/playlists/$playlistId",
          params: { playlistId: playlist.value.playlistId },
        });
        toast.success("Created the playlist");
      } else {
        onClose();

        if (command.group !== "playback" && command.group !== "queue")
          toast.success(`Done: ${command.summary}`);
      }
    } catch (cause) {
      setError(describeFailure(cause));
    } finally {
      setPending(false);
    }
  };

  usePrimary(registerPrimary, () => void run());

  if (outcome !== null)
    return <OutcomePreview outcome={outcome} onClose={onClose} onBack={onBack} />;

  return (
    <PreviewFrame onBack={onBack}>
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">
          {command.group}
          {command.access === "admin" ? " · admin" : ""}
        </span>
        <h2 className="font-sans text-xl/xl font-heavy tracking-tight text-text">
          {command.summary}
        </h2>
      </div>
      {fields.length === 0 ? null : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <ArgsForm
            fields={fields}
            values={values}
            context={context}
            onChange={(field, value) => setEdits((current) => ({ ...current, [field]: value }))}
          />
          <button type="submit" hidden />
        </form>
      )}
      {error === null ? null : (
        <p role="alert" className="font-sans text-sm/sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-1.5 rounded-md bg-surface px-3.5 py-3">
        <span className="font-sans text-xs/xs font-semibold text-text-muted">
          Same command in a terminal
        </span>
        <code className="font-mono text-sm/xs text-text">{cliOf(name)}</code>
      </div>
      <div className="flex gap-2">
        <Button variant="solid" size="sm" pending={pending} onClick={() => void run()}>
          {pending ? "Running…" : "Run"}
        </Button>
      </div>
    </PreviewFrame>
  );
}

function OutcomePreview({
  outcome,
  onClose,
  onBack,
}: {
  readonly outcome: Outcome;
  readonly onClose: () => void;
  readonly onBack: () => void;
}) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  if (outcome.kind === "job")
    return (
      <JobOutcome jobId={outcome.jobId} title={outcome.title} onClose={onClose} onBack={onBack} />
    );

  const value = outcome.kind === "key" ? outcome.key : outcome.link;

  return (
    <PreviewFrame onBack={onBack}>
      <PreviewTitle
        title={outcome.kind === "key" ? "Copy your new key" : "Share the invite link"}
        meta={
          outcome.kind === "key"
            ? "This is the only time it's shown."
            : "It works once and expires in 7 days."
        }
      />
      <div className="flex h-12 items-center gap-2.5 rounded-sm bg-surface pr-1.5 pl-3.5">
        <code className="min-w-0 grow truncate font-mono text-sm/xs text-text select-all">
          {value}
        </code>
        <Button
          variant="solid"
          size="sm"
          className="h-9 rounded-sm px-3"
          onClick={() =>
            void navigator.clipboard.writeText(value).then(
              () => setCopied(true),
              () => toast.error("Couldn't copy. Select it and copy it yourself."),
            )
          }
        >
          {copied ? <CheckIcon strokeWidth={2} /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onClose();
            void navigate({ to: outcome.kind === "key" ? "/settings/keys" : "/settings/people" });
          }}
        >
          {outcome.kind === "key" ? "Open API keys" : "Open People"}
        </Button>
      </div>
    </PreviewFrame>
  );
}

const jobMeta = (job: Job | undefined): string => {
  if (job?.status === "done") return "Finished.";

  if (job?.status === "failed") return job.error ?? "The job failed.";

  return "Runs in the background. Close this any time.";
};

function JobOutcome({
  jobId,
  title,
  onClose,
  onBack,
}: {
  readonly jobId: JobId;
  readonly title: string;
  readonly onClose: () => void;
  readonly onBack: () => void;
}) {
  const job = useRead("jobs.get", { jobId });
  const libraries = useRead("libraries.list", {});
  const navigate = useNavigate();
  const cancel = useRunCancel();
  const path = libraries?.find((library) => library.id === job?.libraryId)?.path;
  const percent = job === undefined ? 0 : (jobPercent(job) ?? 0);
  const active = job !== undefined && (job.status === "running" || job.status === "pending");

  return (
    <PreviewFrame onBack={onBack}>
      <PreviewTitle title={path === undefined ? title : `Scanning ${path}`} meta={jobMeta(job)} />
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="font-sans text-2xl/2xl font-heavy tracking-display text-text">
            {percent}%
          </span>
          <span className="font-mono text-xs/xs text-text-muted">
            {job === undefined || job.total === null
              ? job?.status === "pending"
                ? "WAITING"
                : ""
              : `${formatCount(job.done)} / ${formatCount(job.total)}`}
          </span>
        </div>
        <ProgressBar percent={percent} label={title} />
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onClose();
            void navigate({ to: "/settings/jobs" });
          }}
        >
          Open Jobs
        </Button>
        {active ? (
          <Button variant="ghost" size="sm" onClick={() => cancel(jobId)}>
            Cancel scan
          </Button>
        ) : null}
      </div>
    </PreviewFrame>
  );
}

const useRunCancel = (): ((jobId: JobId) => void) => {
  const convex = useConvex();
  const client = useMemo(() => makeMusicClient(convex), [convex]);

  return (jobId) => {
    client
      .run("jobs.cancel", { jobId })
      .then(() => toast.success("Cancelled the scan"))
      .catch(toastFailure);
  };
};

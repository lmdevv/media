/**
 * The pickers for ID fields in a generated form (F27): one per kind of record, each reading only
 * its own list, all drawing the same selectable rows with the accent check on what is chosen.
 * Songs, albums, and artists come from search, since a library is too large to list.
 */
import type { Entity, FieldSpec, FormValues } from "@music/commands/forms";
import { PlaylistId } from "@music/commands/ids";
import type { Role, SearchResults } from "@music/commands/models";
import { can, roleLabel } from "@music/commands/permissions";
import { useRead } from "@music/sdk/react";
import { Option, Schema } from "effect";
import {
  Disc,
  Folder,
  Key,
  ListMusic,
  Mail,
  MicVocal,
  Monitor,
  Music,
  RotateCw,
  User,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useState } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";

import { Row, RowCheck } from "@/components/ui/row";
import { Text } from "@/components/ui/text";
import {
  jobLine,
  matchesQuery,
  scannableLibraries,
  selectedIds,
  toggleOption,
} from "@/lib/actions";
import { countOf } from "@/lib/format";

import { SearchField } from "./search-field";

/**
 * What every picker takes: its field, the whole form (a playlist entry needs its playlist), and
 * the viewer's role.
 */
export interface PickerProps {
  readonly spec: FieldSpec;
  readonly value: FormValues[string];
  readonly values: FormValues;
  readonly role: Role;
  readonly onChange: (value: FormValues[string]) => void;
}

/** One record a picker offers. */
interface EntityOption {
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
}

/** Lists longer than this get a filter field above them. */
const FILTER_FROM = 12;

const WITHHELD = "A song you can't play";

const decodePlaylistId = Schema.decodeUnknownOption(PlaylistId);

function Note({ children }: { readonly children: string }) {
  return (
    <Text variant="secondary" tone="muted" className="py-3">
      {children}
    </Text>
  );
}

/** Selectable rows for `options`; undefined while they load. */
function OptionRows({
  spec,
  value,
  onChange,
  options,
  icon,
}: Omit<PickerProps, "values" | "role"> & {
  readonly options: ReadonlyArray<EntityOption> | undefined;
  readonly icon: LucideIcon;
}) {
  const [filter, setFilter] = useState("");

  if (options === undefined) return <Note>Loading…</Note>;

  if (options.length === 0) return <Note>Nothing to pick here yet.</Note>;

  const chosen = new Set(selectedIds(value));

  const shown = options.filter((option) =>
    matchesQuery(`${option.label} ${option.detail ?? ""}`, filter),
  );

  return (
    <View>
      {options.length > FILTER_FROM ? (
        <View className="pb-2">
          <SearchField
            value={filter}
            onChangeText={setFilter}
            placeholder={`Filter ${spec.label.toLowerCase()}`}
          />
        </View>
      ) : null}
      {shown.map((option) => (
        <OptionRow
          key={option.key}
          option={option}
          icon={icon}
          selected={chosen.has(option.key)}
          onPress={() => onChange(toggleOption(spec, value, option.key))}
        />
      ))}
    </View>
  );
}

function OptionRow({
  option,
  icon,
  selected,
  onPress,
}: {
  readonly option: EntityOption;
  readonly icon: LucideIcon;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const label = option.detail === undefined ? option.label : `${option.label}, ${option.detail}`;

  return (
    <Row
      title={option.label}
      {...(option.detail === undefined ? {} : { subtitle: option.detail })}
      leading={{ kind: "icon", icon, tone: "muted" }}
      trailing={selected ? <RowCheck /> : null}
      accessibilityLabel={selected ? `${label}, selected` : label}
      onPress={onPress}
    />
  );
}

function LibraryPicker(props: PickerProps) {
  const libraries = useRead("libraries.list", {});

  return (
    <OptionRows
      {...props}
      icon={Folder}
      options={
        libraries === undefined
          ? undefined
          : scannableLibraries(libraries).map((library) => ({
              key: library.id,
              label: library.name,
              detail: library.path ?? "",
            }))
      }
    />
  );
}

function JobPicker(props: PickerProps) {
  const jobs = useRead("jobs.list", {});

  return (
    <OptionRows
      {...props}
      icon={RotateCw}
      options={jobs
        ?.filter((job) => job.status === "pending" || job.status === "running")
        .map((job) => ({ key: job.id, label: job.label, detail: jobLine(job) }))}
    />
  );
}

function ApiKeyPicker(props: PickerProps) {
  const keys = useRead("keys.list", {});

  return (
    <OptionRows
      {...props}
      icon={Key}
      options={keys?.map((key) => ({ key: key.id, label: key.name, detail: `${key.prefix}…` }))}
    />
  );
}

function InvitePicker(props: PickerProps) {
  const invites = useRead("invites.list", {});

  return (
    <OptionRows
      {...props}
      icon={Mail}
      options={invites
        ?.filter((invite) => invite.status === "open")
        .map((invite) => ({
          key: invite.id,
          label: invite.email ?? "Open invite",
          detail: `Invited as ${roleLabel(invite.role).toLowerCase()}`,
        }))}
    />
  );
}

/**
 * People on the server. Admins read the full list; Jam hosts who aren't admins (approve, remove)
 * get the directory, since the full list would refuse them. Guests have neither.
 */
function PersonPicker(props: PickerProps) {
  const admin = can(props.role, "admin");
  const people = useRead("people.list", admin ? {} : "skip");
  const directory = useRead("people.directory", !admin && can(props.role, "share") ? {} : "skip");

  const options = admin
    ? people?.map((person) => ({
        key: person.id,
        label: person.name ?? person.email,
        detail: `${roleLabel(person.role)}${person.suspended ? " · Suspended" : ""}`,
      }))
    : can(props.role, "share")
      ? directory?.map((person) => ({
          key: person.id,
          label: person.name,
          detail: roleLabel(person.role),
        }))
      : [];

  return <OptionRows {...props} icon={User} options={options} />;
}

/** People to share a playlist with. Guests may leave a playlist but can't read the directory. */
function ShareePicker(props: PickerProps) {
  const allowed = can(props.role, "share");
  const directory = useRead("people.directory", allowed ? {} : "skip");

  return (
    <OptionRows
      {...props}
      icon={User}
      options={
        allowed
          ? directory?.map((person) => ({
              key: person.id,
              label: person.name,
              detail: roleLabel(person.role),
            }))
          : []
      }
    />
  );
}

/**
 * Your playlists, then the ones shared with you: a collaborator adds, removes, and moves songs in
 * those, and anyone may leave one. The server refuses owner-only commands on the shared ones.
 */
function PlaylistPicker(props: PickerProps) {
  const own = useRead("playlists.list", {});
  const shared = useRead("playlists.shared", {});

  return (
    <OptionRows
      {...props}
      icon={ListMusic}
      options={
        own === undefined || shared === undefined
          ? undefined
          : [
              ...own.map((playlist) => ({
                key: playlist.id,
                label: playlist.name,
                detail: countOf(playlist.trackCount, "song"),
              })),
              ...shared.map((playlist) => ({
                key: playlist.id,
                label: playlist.name,
                detail: `Shared by ${playlist.owner?.name ?? "someone"} · ${countOf(playlist.trackCount, "song")}`,
              })),
            ]
      }
    />
  );
}

function DevicePicker(props: PickerProps) {
  const devices = useRead("devices.list", {});

  return (
    <OptionRows
      {...props}
      icon={Monitor}
      options={devices?.map((device) => ({
        key: device.id,
        label: device.name,
        detail: device.online ? "Online" : "Offline",
      }))}
    />
  );
}

function QueueItemPicker(props: PickerProps) {
  const queue = useRead("queue.list", {});

  return (
    <OptionRows
      {...props}
      icon={Music}
      options={queue?.queue.map((entry, position) => ({
        key: entry.itemId,
        label: entry.withheld === true ? WITHHELD : entry.title,
        detail: position === queue.index ? "Playing now" : entry.artist,
      }))}
    />
  );
}

/** Entries of the playlist chosen above; nothing until one is. */
function PlaylistItemPicker(props: PickerProps) {
  const playlistId = Option.getOrNull(decodePlaylistId(props.values["playlistId"]));
  const playlist = useRead("playlists.get", playlistId === null ? "skip" : { playlistId });

  if (playlistId === null) return <Note>Choose a playlist first.</Note>;

  return (
    <OptionRows
      {...props}
      icon={Music}
      options={playlist?.items.map((item) => ({
        key: item.itemId,
        label: item.track?.title ?? WITHHELD,
        detail: item.track?.artist ?? "In a library that isn't shared with you",
      }))}
    />
  );
}

/** How a search picker reads its kind of record out of the results. */
const SEARCH_KINDS = {
  track: {
    icon: Music,
    placeholder: "Search songs",
    options: (results: SearchResults) =>
      results.tracks.map((track) => ({
        key: track.id,
        label: track.title,
        detail: `${track.artist} · ${track.album}`,
      })),
  },
  album: {
    icon: Disc,
    placeholder: "Search albums",
    options: (results: SearchResults) =>
      results.albums.map((album) => ({ key: album.id, label: album.title, detail: album.artist })),
  },
  artist: {
    icon: MicVocal,
    placeholder: "Search artists",
    options: (results: SearchResults) =>
      results.artists.map((artist) => ({
        key: artist.id,
        label: artist.name,
        detail: countOf(artist.albumCount, "album"),
      })),
  },
} as const;

/** The longest query `search` accepts. */
const QUERY_LIMIT = 200;

/**
 * Songs, albums, or artists found by typing. What is chosen stays listed first while the search
 * changes, so a list of songs can be built from several searches.
 */
function SearchPicker({
  kind,
  spec,
  value,
  onChange,
}: PickerProps & { readonly kind: keyof typeof SEARCH_KINDS }) {
  const [query, setQuery] = useState("");
  // Labels of the records picked so far, which the current results may no longer include.
  const [picked, setPicked] = useState<Readonly<Record<string, EntityOption>>>({});
  const text = query.trim().slice(0, QUERY_LIMIT);
  const results = useRead("search", text === "" ? "skip" : { query: text, limit: 20 });
  const { icon, placeholder, options } = SEARCH_KINDS[kind];
  const chosen = selectedIds(value);
  const found = results === undefined ? [] : options(results);

  const choose = (option: EntityOption) => {
    setPicked((current) => ({ ...current, [option.key]: option }));
    onChange(toggleOption(spec, value, option.key));
  };

  return (
    <View>
      <View className="pb-2">
        <SearchField value={query} onChangeText={setQuery} placeholder={placeholder} />
      </View>
      {chosen.map((id) => {
        const option = picked[id] ?? { key: id, label: id };

        return (
          <OptionRow key={id} option={option} icon={icon} selected onPress={() => choose(option)} />
        );
      })}
      {found
        .filter((option) => !chosen.includes(option.key))
        .map((option) => (
          <OptionRow
            key={option.key}
            option={option}
            icon={icon}
            selected={false}
            onPress={() => choose(option)}
          />
        ))}
      {text !== "" && results !== undefined && found.length === 0 ? (
        <Note>{`Nothing matches “${text}”.`}</Note>
      ) : null}
    </View>
  );
}

/** The picker for each kind of record an ID field points at. */
export const PICKERS = {
  library: LibraryPicker,
  job: JobPicker,
  apiKey: ApiKeyPicker,
  invite: InvitePicker,
  person: PersonPicker,
  sharee: ShareePicker,
  playlist: PlaylistPicker,
  device: DevicePicker,
  queueItem: QueueItemPicker,
  playlistItem: PlaylistItemPicker,
  track: (props: PickerProps) => <SearchPicker {...props} kind="track" />,
  album: (props: PickerProps) => <SearchPicker {...props} kind="album" />,
  artist: (props: PickerProps) => <SearchPicker {...props} kind="artist" />,
} as const satisfies Record<Entity, (props: PickerProps) => ReactNode>;

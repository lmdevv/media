import type { AlbumId, ArtistId, PlaylistId } from "@music/commands/ids";
import { usePlayer } from "@music/player/react";
import { useRead } from "@music/sdk/react";
import { Chip } from "@music/ui/components/chip";
import { Input } from "@music/ui/components/input";
import { Switch } from "@music/ui/components/switch";
import { cn } from "@music/ui/lib/utils";
import type { ReactNode } from "react";

import { formatDuration } from "@/lib/format";

import type { Entity, FieldSpec, FormValues } from "./fields";

/** What the screen behind the menu is showing, used to fill and offer arguments. */
export interface MenuContext {
  readonly albumId: AlbumId | null;
  readonly artistId: ArtistId | null;
  readonly playlistId: PlaylistId | null;
}

/** One choice in an ID picker: the wire value, or a list of them for multi-song fields. */
interface EntityOption {
  readonly key: string;
  readonly value: string | ReadonlyArray<string>;
  readonly label: string;
  readonly detail?: string;
}

/**
 * The records an ID argument can point at, drawn from what is on screen and in your library:
 * the playing song and queue, the album or playlist in view, your playlists, devices, and so on.
 */
const useEntityOptions = (
  entity: Entity,
  many: boolean,
  context: MenuContext,
): ReadonlyArray<EntityOption> => {
  const player = usePlayer();

  const album = useRead(
    "albums.get",
    entity === "track" && context.albumId !== null ? { albumId: context.albumId } : "skip",
  );

  const playlist = useRead(
    "playlists.get",
    (entity === "playlistItem" || entity === "track") && context.playlistId !== null
      ? { playlistId: context.playlistId }
      : "skip",
  );

  const playlists = useRead("playlists.list", entity === "playlist" ? {} : "skip");
  const libraries = useRead("libraries.list", entity === "library" ? {} : "skip");
  const jobs = useRead("jobs.list", entity === "job" ? {} : "skip");
  const keys = useRead("keys.list", entity === "apiKey" ? {} : "skip");
  const invites = useRead("invites.list", entity === "invite" ? {} : "skip");
  const devices = useRead("devices.list", entity === "device" ? {} : "skip");

  const artist = useRead(
    "artists.get",
    entity === "artist" && context.artistId !== null ? { artistId: context.artistId } : "skip",
  );

  switch (entity) {
    case "track": {
      const options: Array<EntityOption> = [];

      if (player.track !== null) {
        options.push({
          key: "playing",
          value: many ? [player.track.id] : player.track.id,
          label: player.track.title,
          detail: "Playing now",
        });
      }

      if (many && album !== undefined) {
        options.push({
          key: "album",
          value: album.tracks.map((track) => track.id),
          label: album.album.title,
          detail: `Album in view · ${album.tracks.length} songs`,
        });
      }

      // Songs whose file is gone can't play, so the option leaves them out.
      const playable = (playlist?.items ?? []).flatMap((item) =>
        item.available ? [item.track.id] : [],
      );

      if (many && playlist !== undefined && playable.length > 0) {
        options.push({
          key: "playlist",
          value: playable,
          label: playlist.playlist.name,
          detail: `Playlist in view · ${playable.length} songs`,
        });
      }

      if (many && player.queue.length > 1) {
        options.push({
          key: "queue",
          value: player.queue.map((track) => track.id),
          label: "The current queue",
          detail: `${player.queue.length} songs`,
        });
      }

      for (const track of album?.tracks ?? []) {
        if (track.id !== player.track?.id)
          options.push({
            key: track.id,
            value: many ? [track.id] : track.id,
            label: track.title,
            detail: track.album,
          });
      }

      return options;
    }

    case "album":
      return [
        ...(context.albumId === null
          ? []
          : [{ key: "view", value: context.albumId, label: "The album in view" }]),
        ...(player.track === null
          ? []
          : [
              {
                key: "playing",
                value: player.track.albumId,
                label: player.track.album,
                detail: "Playing now",
              },
            ]),
      ];

    case "artist":
      return [
        ...(artist === undefined
          ? []
          : [
              {
                key: "view",
                value: artist.artist.id,
                label: artist.artist.name,
                detail: "Artist in view",
              },
            ]),
        ...(player.track === null
          ? []
          : [
              {
                key: "playing",
                value: player.track.artistId,
                label: player.track.artist,
                detail: "Playing now",
              },
            ]),
      ];

    case "playlist":
      return (playlists ?? []).map((entry) => ({
        key: entry.id,
        value: entry.id,
        label: entry.name,
        detail: `${entry.trackCount} songs`,
      }));

    case "playlistItem":
      return (playlist?.items ?? []).map((item) => ({
        key: item.itemId,
        value: item.itemId,
        label: item.track.title,
        detail: item.track.artist,
      }));

    case "library":
      return (libraries ?? []).map((library) => ({
        key: library.id,
        value: library.id,
        label: library.path,
        detail: library.name,
      }));

    case "job":
      return (jobs ?? [])
        .filter((job) => job.status === "running" || job.status === "pending")
        .map((job) => ({ key: job.id, value: job.id, label: job.label, detail: job.status }));

    case "apiKey":
      return (keys ?? []).map((key) => ({
        key: key.id,
        value: key.id,
        label: key.name,
        detail: `${key.prefix}…`,
      }));

    case "invite":
      return (invites ?? []).map((invite) => ({
        key: invite.id,
        value: invite.id,
        label: invite.email ?? "Open invite",
        detail: invite.role,
      }));

    case "device":
      return (devices ?? [])
        .filter((device) => device.id !== player.deviceId)
        .map((device) => ({
          key: device.id,
          value: device.id,
          label: device.name,
          detail: device.online ? "Online" : "Offline",
        }));

    default:
      return [];
  }
};

/** The current value of a field as a number string, for number inputs. */
const asText = (value: FormValues[string]): string =>
  value === undefined || value === true || value === false || Array.isArray(value)
    ? ""
    : String(value);

function Row({
  label,
  optional,
  children,
}: {
  readonly label: string;
  readonly optional: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-sans text-xs/xs font-semibold text-text-muted">
        {label}
        {optional ? " (optional)" : ""}
      </span>
      {children}
    </div>
  );
}

function IdField({
  spec,
  entity,
  many,
  value,
  context,
  onChange,
}: {
  readonly spec: FieldSpec;
  readonly entity: Entity;
  readonly many: boolean;
  readonly value: FormValues[string];
  readonly context: MenuContext;
  readonly onChange: (value: string | ReadonlyArray<string> | undefined) => void;
}) {
  const options = useEntityOptions(entity, many, context);
  const selected = options.find((option) => JSON.stringify(option.value) === JSON.stringify(value));

  return (
    <Row label={spec.label} optional={spec.optional}>
      {options.length === 0 ? (
        <span className="font-sans text-sm/xs text-text-muted">Nothing to pick here yet.</span>
      ) : (
        <div
          role="listbox"
          aria-label={spec.label}
          className="flex max-h-37 flex-col gap-0.5 overflow-y-auto"
        >
          {options.map((option) => {
            const chosen = option === selected;

            return (
              <button
                key={option.key}
                type="button"
                role="option"
                aria-selected={chosen}
                onClick={() => onChange(chosen && spec.optional ? undefined : option.value)}
                className={cn(
                  "flex h-9 shrink-0 items-center justify-between gap-3 rounded-sm px-2.5 text-left font-sans text-sm/xs",
                  chosen ? "bg-text text-text-inverse" : "bg-surface text-text hover:bg-border",
                )}
              >
                <span className="truncate font-medium">{option.label}</span>
                {option.detail === undefined ? null : (
                  <span
                    className={cn(
                      "shrink-0 truncate",
                      chosen ? "text-text-inverse/70" : "text-text-muted",
                    )}
                  >
                    {option.detail}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </Row>
  );
}

/** The inline form for a command's arguments, generated from its schema fields. */
export function ArgsForm({
  fields,
  values,
  context,
  onChange,
}: {
  readonly fields: ReadonlyArray<FieldSpec>;
  readonly values: FormValues;
  readonly context: MenuContext;
  readonly onChange: (name: string, value: FormValues[string]) => void;
}) {
  const player = usePlayer();

  return (
    <div className="flex flex-col gap-3.5">
      {fields.map((spec) => {
        const value = values[spec.name];
        const field = spec.field;

        switch (field.kind) {
          case "id":
          case "ids":
            return (
              <IdField
                key={spec.name}
                spec={spec}
                entity={field.entity}
                many={field.kind === "ids"}
                value={value}
                context={context}
                onChange={(next) => onChange(spec.name, next)}
              />
            );

          case "boolean":
            return (
              <label key={spec.name} className="flex items-center justify-between gap-3">
                <span className="font-sans text-sm/xs font-medium text-text">{spec.label}</span>
                <Switch
                  checked={value === true}
                  onCheckedChange={(checked) => onChange(spec.name, checked)}
                />
              </label>
            );

          case "choice":
            return (
              <Row key={spec.name} label={spec.label} optional={spec.optional}>
                <div className="flex flex-wrap gap-1.5">
                  {field.options.map((option) => (
                    <Chip
                      key={option}
                      size="sm"
                      selected={value === option}
                      onClick={() =>
                        onChange(spec.name, value === option && spec.optional ? undefined : option)
                      }
                    >
                      {option}
                    </Chip>
                  ))}
                </div>
              </Row>
            );

          case "number":
            return (
              <Row key={spec.name} label={spec.label} optional={spec.optional}>
                <Input
                  size="md"
                  type="number"
                  inputMode="decimal"
                  aria-label={spec.label}
                  value={asText(value)}
                  min={field.min ?? undefined}
                  max={field.max ?? undefined}
                  step={field.integer ? 1 : "any"}
                  onChange={(event) =>
                    onChange(spec.name, event.target.value === "" ? undefined : event.target.value)
                  }
                  end={
                    spec.name === "positionMs" && player.track !== null ? (
                      <span className="font-mono text-xs/xs text-text-muted">
                        of {formatDuration(player.durationMs)}
                      </span>
                    ) : null
                  }
                />
              </Row>
            );

          case "text":
            return (
              <Row key={spec.name} label={spec.label} optional={spec.optional}>
                <Input
                  size="md"
                  aria-label={spec.label}
                  className={field.mono ? "font-mono" : undefined}
                  spellCheck={!field.mono}
                  value={asText(value)}
                  onChange={(event) =>
                    onChange(spec.name, event.target.value === "" ? undefined : event.target.value)
                  }
                />
              </Row>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}

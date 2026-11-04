import type {
  AlbumCard as Album,
  ArtistCard as Artist,
  Playlist,
  Track,
} from "@music/commands/models";
import { usePlayer, usePlayerPosition } from "@music/player/react";
import { useRead } from "@music/sdk/react";
import { useNavigate } from "@tanstack/react-router";
import { memo } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";

import { ProgressBar } from "@/components/auth/scan-progress";
import { Artwork } from "@/components/library/artwork";
import { usePlayAlbum, usePlayArtist, usePlayTracks } from "@/components/library/cards";
import { perform } from "@/components/player/player-actions";
import { useQueueActions } from "@/components/playlists/track-menu";
import { useUi } from "@/components/shell/ui-state";
import { formatDuration, formatTotal, plural } from "@/lib/format";
import { playableTracks } from "@/lib/playlist-entries";

import type { MenuContext } from "./args-form";
import { CommandPreview } from "./command-preview";
import type { Item } from "./items";
import { PreviewActions, PreviewFrame, PreviewTitle, previewArt } from "./preview-frame";
import type { PreviewProps } from "./preview-frame";

const playIcon = <PlayIcon fill="currentColor" strokeWidth={0} />;

/**
 * The preview pane for the selected row: artwork, detail, and buttons for library records, the
 * form for commands. It registers its actions so their chords and the footer run them. Memoized,
 * so typing in the search field doesn't re-render it until the selection changes.
 */
export const Preview = memo(function Preview({
  item,
  context,
  onClose,
  onBack,
  registerActions,
}: PreviewProps & {
  readonly item: Item;
  readonly context: MenuContext;
}) {
  switch (item.kind) {
    case "now":
      return (
        <NowPreview
          track={item.track}
          onClose={onClose}
          onBack={onBack}
          registerActions={registerActions}
        />
      );
    case "album":
      return (
        <AlbumPreview
          album={item.album}
          onClose={onClose}
          onBack={onBack}
          registerActions={registerActions}
        />
      );
    case "artist":
      return (
        <ArtistPreview
          artist={item.artist}
          onClose={onClose}
          onBack={onBack}
          registerActions={registerActions}
        />
      );
    case "track":
      return (
        <TrackPreview
          track={item.track}
          tracks={item.tracks}
          onClose={onClose}
          onBack={onBack}
          registerActions={registerActions}
        />
      );
    case "playlist":
      return (
        <PlaylistPreview
          playlist={item.playlist}
          onClose={onClose}
          onBack={onBack}
          registerActions={registerActions}
        />
      );
    case "command":
      return (
        <CommandPreview
          name={item.name}
          fields={item.fields}
          context={context}
          onClose={onClose}
          onBack={onBack}
          registerActions={registerActions}
        />
      );
    case "action":
      return <ActionPreview item={item} onBack={onBack} registerActions={registerActions} />;
    default:
      return null;
  }
});

function NowProgress({ durationMs }: { readonly durationMs: number }) {
  const position = usePlayerPosition();

  return (
    <div className="flex flex-col gap-1.5">
      <ProgressBar
        percent={Math.min(100, (position / Math.max(1, durationMs)) * 100)}
        label="Position"
        className="h-1 [&>div]:bg-text"
      />
      <div className="flex justify-between font-mono text-xs/xs text-text-muted">
        <span>{formatDuration(position)}</span>
        <span>{formatDuration(durationMs)}</span>
      </div>
    </div>
  );
}

function NowPreview({
  track,
  onClose,
  onBack,
  registerActions,
}: PreviewProps & { readonly track: Track }) {
  const player = usePlayer();
  const ui = useUi();
  const playing = player.status === "playing";
  const upNext = player.queue.slice(player.index + 1, player.index + 3);

  return (
    <PreviewFrame onBack={onBack}>
      <Artwork url={track.artUrl} seed={track.albumId} className={previewArt} />
      <PreviewTitle title={track.title} meta={`${track.artist} · ${track.album}`} />
      <NowProgress durationMs={player.durationMs} />
      {upNext.length === 0 ? null : (
        <div className="flex flex-col">
          <span className="pb-1.5 font-sans text-xs/xs font-semibold text-text-muted">Up next</span>
          {upNext.map((next) => (
            <div
              key={next.itemId}
              className="flex h-7.5 items-center gap-2.5 border-t border-border"
            >
              <span className="grow truncate font-sans text-sm/xs text-text">{next.title}</span>
              <span className="max-w-1/2 shrink-0 truncate font-sans text-sm/xs text-text-muted">
                {next.artist}
              </span>
            </div>
          ))}
        </div>
      )}
      <PreviewActions
        registerActions={registerActions}
        actions={{
          "command-menu.enter": {
            label: playing ? "Pause" : "Resume",
            icon: playing ? <PauseIcon fill="currentColor" strokeWidth={0} /> : playIcon,
            run: () => perform(player.togglePlay()),
          },
          "command-menu.mod-enter": {
            label: "Open queue",
            run: () => {
              onClose();
              ui.setNowPlaying("queue");
            },
          },
        }}
      />
    </PreviewFrame>
  );
}

function AlbumPreview({
  album,
  onClose,
  onBack,
  registerActions,
}: PreviewProps & { readonly album: Album }) {
  const detail = useRead("albums.get", { albumId: album.id });
  const playAlbum = usePlayAlbum();
  const navigate = useNavigate();
  const { playNext } = useQueueActions();

  const play = (shuffle: boolean) => {
    onClose();
    void playAlbum(album.id, shuffle);
  };

  const open = () => {
    onClose();
    void navigate({ to: "/albums/$albumId", params: { albumId: album.id } });
  };

  return (
    <PreviewFrame onBack={onBack}>
      <button
        type="button"
        tabIndex={-1}
        onClick={open}
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
          {detail.tracks.slice(0, 2).map((track, index) => (
            <div key={track.id} className="flex h-7.5 items-center gap-2.5 border-t border-border">
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
      <PreviewActions
        registerActions={registerActions}
        actions={{
          "command-menu.enter": { label: "Open", run: open },
          "command-menu.mod-enter": { label: "Play", icon: playIcon, run: () => play(false) },
          "command-menu.shift-enter": { label: "Shuffle", run: () => play(true) },
          "command-menu.alt-enter": {
            label: "Play next",
            disabled: detail === undefined,
            run: () => {
              if (detail !== undefined) playNext(detail.tracks);
            },
          },
        }}
      />
    </PreviewFrame>
  );
}

function ArtistPreview({
  artist,
  onClose,
  onBack,
  registerActions,
}: PreviewProps & { readonly artist: Artist }) {
  const playArtist = usePlayArtist();
  const navigate = useNavigate();

  const play = (shuffle: boolean) => {
    onClose();
    void playArtist(artist.id, shuffle);
  };

  return (
    <PreviewFrame onBack={onBack}>
      <Artwork url={artist.artUrl} seed={artist.id} round className="size-37" />
      <PreviewTitle title={artist.name} meta={`Artist · ${plural(artist.albumCount, "album")}`} />
      <PreviewActions
        registerActions={registerActions}
        actions={{
          "command-menu.enter": {
            label: "Open",
            run: () => {
              onClose();
              void navigate({ to: "/artists/$artistId", params: { artistId: artist.id } });
            },
          },
          "command-menu.mod-enter": { label: "Play", icon: playIcon, run: () => play(false) },
          "command-menu.shift-enter": { label: "Shuffle", run: () => play(true) },
        }}
      />
    </PreviewFrame>
  );
}

function TrackPreview({
  track,
  tracks,
  onClose,
  onBack,
  registerActions,
}: PreviewProps & { readonly track: Track; readonly tracks: ReadonlyArray<Track> }) {
  const play = usePlayTracks();
  const { playNext, addToQueue } = useQueueActions();

  const start = () => {
    onClose();
    void play(tracks, { index: Math.max(0, tracks.indexOf(track)) });
  };

  return (
    <PreviewFrame onBack={onBack}>
      <Artwork url={track.artUrl} seed={track.albumId} className={previewArt} />
      <PreviewTitle
        title={track.title}
        meta={`${track.artist} · ${track.album} · ${formatDuration(track.durationMs)}`}
      />
      <PreviewActions
        registerActions={registerActions}
        actions={{
          "command-menu.enter": { label: "Play", icon: playIcon, run: start },
          "command-menu.shift-enter": { label: "Add to queue", run: () => addToQueue([track]) },
          "command-menu.alt-enter": { label: "Play next", run: () => playNext([track]) },
        }}
      />
    </PreviewFrame>
  );
}

function PlaylistPreview({
  playlist,
  onClose,
  onBack,
  registerActions,
}: PreviewProps & { readonly playlist: Playlist }) {
  const navigate = useNavigate();
  const detail = useRead("playlists.get", { playlistId: playlist.id });
  const play = usePlayTracks();

  const open = () => {
    onClose();
    void navigate({ to: "/playlists/$playlistId", params: { playlistId: playlist.id } });
  };

  const entries = detail === undefined ? [] : playableTracks(detail.items);

  const start = (shuffle: boolean) => {
    onClose();
    void play(entries, { shuffle });
  };

  return (
    <PreviewFrame onBack={onBack}>
      <Artwork url={playlist.artUrls[0] ?? null} seed={playlist.id} className={previewArt} />
      <PreviewTitle
        title={playlist.name}
        meta={`Playlist · ${plural(playlist.trackCount, "song")}${playlist.trackCount > 0 ? ` · ${formatTotal(playlist.durationMs)}` : ""}`}
      />
      <PreviewActions
        registerActions={registerActions}
        actions={{
          "command-menu.enter": { label: "Open", run: open },
          "command-menu.mod-enter": {
            label: "Play",
            icon: playIcon,
            disabled: entries.length === 0,
            run: () => start(false),
          },
          "command-menu.shift-enter": {
            label: "Shuffle",
            disabled: entries.length === 0,
            run: () => start(true),
          },
        }}
      />
    </PreviewFrame>
  );
}

function ActionPreview({
  item,
  onBack,
  registerActions,
}: Omit<PreviewProps, "onClose"> & { readonly item: Extract<Item, { kind: "action" }> }) {
  return (
    <PreviewFrame onBack={onBack}>
      <span className="flex size-12 items-center justify-center rounded-lg bg-surface">
        <item.icon aria-hidden className="size-6" />
      </span>
      <PreviewTitle title={item.title} meta={item.detail} />
      <PreviewActions
        registerActions={registerActions}
        actions={{ "command-menu.enter": { label: item.label, run: item.run } }}
      />
    </PreviewFrame>
  );
}

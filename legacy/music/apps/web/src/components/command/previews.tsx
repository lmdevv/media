import type {
  AlbumCard as Album,
  ArtistCard as Artist,
  Playlist,
  Track,
} from "@music/commands/models";
import { usePlayer, usePlayerPosition } from "@music/player/react";
import { useRead } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { PauseIcon, PlayIcon, ShuffleIcon, SkipForwardIcon } from "lucide-react";

import { ProgressBar } from "@/components/auth/scan-progress";
import { Artwork } from "@/components/library/artwork";
import { usePlayAlbum, usePlayArtist, usePlayTracks } from "@/components/library/cards";
import { perform } from "@/components/player/controls";
import { useQueueActions } from "@/components/playlists/track-menu";
import { useUi } from "@/components/shell/ui-state";
import { formatDuration, formatTotal, plural } from "@/lib/format";
import { playableTracks } from "@/lib/playlist-entries";

import type { MenuContext } from "./args-form";
import { CommandPreview } from "./command-preview";
import type { Item } from "./items";
import { PreviewFrame, PreviewTitle, previewArt, usePrimary } from "./preview-frame";
import type { PreviewProps } from "./preview-frame";

/**
 * The preview pane for the selected row: artwork, detail, and buttons for library records, the
 * form for commands. It registers its primary action so Enter and the footer run it.
 */
export function Preview({
  item,
  context,
  onClose,
  onBack,
  registerPrimary,
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
      <Artwork url={artist.artUrl} seed={artist.id} round className="size-37" />
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
            void play(playableTracks(detail?.items ?? []));
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

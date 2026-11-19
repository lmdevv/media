import type { PlaybackController } from "@media/player/playback-controller";
import { useGuestPlayer, useGuestPosition } from "@media/player/guest-react";
import type { GuestTrack } from "@media/player/guest-react";
import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { GuestUnavailable } from "@/guest/unavailable";
import { useAllPages } from "@media/ui/lib/pages";
import { isRenewing, linkRefused, useIdentityRetry } from "@media/ui/lib/session-identity";
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { MEDIA_BASE_URL } from "@/env";
import { formatDuration } from "@/lib/format";
import { BlankPage, useSignOut } from "@/session/session";
import { UnreachableScreen } from "./unreachable";

type Item = Parameters<PlatformSdk["music"]["playback"]["get"]>[0]["item"];

type Detail = Awaited<ReturnType<PlatformSdk["music"]["playback"]["get"]>>;

type Share = { readonly sharedBy: string; readonly expiresAt: number };

/** A shell-free share whose reads and playback stay within the link's target. */
export function GuestItem({ item, ...share }: Share & { readonly item: Item }) {
  const platform = usePlatform();
  const leave = useSignOut();
  const result = usePlatformQuery(platform.music.playback.get, { item });
  useIdentityRetry(result);

  if (result.status === "loading" || (result.status === "error" && isRenewing(result.error)))
    return <BlankPage />;

  if (result.status === "error")
    return linkRefused(result.error) ? (
      <GuestUnavailable onLeave={leave} />
    ) : (
      <UnreachableScreen retry={result.retry} />
    );
  const detail = result.data;

  return detail.kind === "album" ? (
    <GuestAlbum detail={detail} {...share} />
  ) : (
    <GuestPlayer key={detail.id} detail={detail} tracks={[detail]} {...share} />
  );
}

function GuestAlbum({
  detail,
  ...share
}: Share & { readonly detail: Extract<Detail, { readonly kind: "album" }> }) {
  const platform = usePlatform();

  const songs = useAllPages(platform.music.playback.tracks, (paginationOpts) => ({
    albumId: detail.id,
    paginationOpts,
  }));

  const leave = useSignOut();

  const failure =
    songs.status === "failed"
      ? songs
      : songs.status === "ready" && songs.next.kind === "failed"
        ? songs.next
        : null;

  useIdentityRetry(
    failure === null
      ? { status: "loading" }
      : { status: "error", error: failure.error, retry: failure.retry },
  );

  if (failure !== null) {
    if (isRenewing(failure.error)) return <BlankPage />;

    return linkRefused(failure.error) ? (
      <GuestUnavailable onLeave={leave} />
    ) : (
      <UnreachableScreen retry={failure.retry} />
    );
  }

  if (songs.status !== "ready") return <BlankPage />;

  if (songs.next.kind !== "done") return <BlankPage />;

  return (
    <GuestPlayer
      key={songs.rows.map((track) => track.id).join(":")}
      detail={detail}
      tracks={songs.rows}
      {...share}
    />
  );
}

function GuestPlayer({
  detail,
  tracks,
  sharedBy,
  expiresAt,
}: Share & { readonly detail: Detail; readonly tracks: ReadonlyArray<GuestTrack> }) {
  const leave = useSignOut();
  const { controller, state } = useGuestPlayer(tracks, MEDIA_BASE_URL);
  const index = tracks.findIndex((track) => track.id === state.current);
  const track = tracks[index];
  const playing = state.engineStatus === "playing" || state.engineStatus === "buffering";
  const artwork = detail.artUrl === null ? null : `${MEDIA_BASE_URL}${detail.artUrl}`;

  return (
    <main className="min-h-dvh bg-bg px-5 py-8 font-sans text-text md:px-12 md:py-12">
      <div className="mx-auto flex max-w-content flex-col gap-8">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm/sm text-text-muted">
            Shared by {sharedBy}
            <br />
            Ends {new Date(expiresAt).toLocaleString()}
          </p>
          <Button
            variant="ghost"
            onClick={() => {
              void leave().catch(() => undefined);
            }}
          >
            Leave
          </Button>
        </div>
        <section className="flex flex-col gap-6 md:flex-row md:items-end">
          {artwork === null ? null : (
            <img
              src={artwork}
              alt=""
              className="aspect-square w-full rounded-lg object-cover md:w-64"
            />
          )}
          <div className="flex flex-col gap-3">
            <p className="text-sm/sm text-text-muted">
              {detail.kind === "album" ? "Album" : "Song"}
            </p>
            <h1 className="text-xl/xl font-heavy tracking-tight md:text-2xl/2xl">{detail.title}</h1>
            <p className="text-md/base text-text-muted">
              {detail.artist}
              {detail.kind === "album" && detail.year !== null ? ` · ${detail.year}` : ""}
            </p>
          </div>
        </section>
        <section aria-label="Player" className="flex flex-col gap-4 rounded-lg bg-surface p-5">
          <p aria-live="polite" className="text-md/base font-semibold">
            {track?.title}
          </p>
          <div className="flex items-center justify-center gap-5">
            <Button
              variant="icon"
              size="icon-lg"
              aria-label="Previous"
              disabled={track === undefined}
              onClick={() => {
                void controller.previous();
              }}
            >
              <SkipBackIcon />
            </Button>
            <Button
              variant="primary"
              size="icon-lg"
              aria-label={playing ? "Pause" : "Play"}
              disabled={track === undefined}
              onClick={() => {
                void controller.togglePlay();
              }}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </Button>
            <Button
              variant="icon"
              size="icon-lg"
              aria-label="Next"
              disabled={index < 0 || index >= tracks.length - 1}
              onClick={() => {
                void controller.next();
              }}
            >
              <SkipForwardIcon />
            </Button>
          </div>
          <GuestProgress controller={controller} duration={track?.durationMs ?? 0} />
          {state.error === null ? null : <p role="status">{state.error}</p>}
        </section>
        <section aria-label="Queue" className="flex flex-col gap-3">
          <h2 className="text-lg/lg font-bold">Songs</h2>
          <ol className="flex flex-col">
            {tracks.map((song, at) => (
              <li key={song.id}>
                <button
                  type="button"
                  aria-label={`Play ${song.title}`}
                  aria-current={song.id === state.current ? "true" : undefined}
                  className="flex min-h-row w-full cursor-pointer items-center gap-4 rounded-md px-3 py-3 text-left hover:bg-surface"
                  onClick={() => {
                    void controller.jump(song.id);
                  }}
                >
                  <span className="w-5 text-sm/sm text-text-muted">{at + 1}</span>
                  <span className="flex-1 font-medium">{song.title}</span>
                  <span className="font-mono text-xs/xs text-text-muted">
                    {formatDuration(song.durationMs)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}

function GuestProgress({
  controller,
  duration,
}: {
  readonly controller: PlaybackController;
  readonly duration: number;
}) {
  const position = useGuestPosition(controller);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = Math.min(dragging ?? position, duration);

  return (
    <>
      <Slider
        aria-label="Seek"
        min={0}
        max={Math.max(duration, 1)}
        step={1000}
        value={shown}
        disabled={duration === 0}
        onValueChange={setDragging}
        onValueCommitted={(value) => {
          setDragging(null);
          controller.seek(value);
        }}
      />
      <div className="flex justify-between font-mono text-xs/xs text-text-muted">
        <span>{formatDuration(shown)}</span>
        <span>{formatDuration(duration)}</span>
      </div>
    </>
  );
}

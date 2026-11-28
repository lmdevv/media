import type { PlaybackController } from "@media/player/playback-controller";
import { useGuestPlayer, useGuestPosition } from "@media/player/guest-react";
import type { GuestTrack } from "@media/player/guest-react";
import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import type { QueryState } from "@media/sdk/react";
import { GuestRead } from "@media/ui/components/guest-share";
import { useAllPages } from "@media/ui/lib/pages";
import type { Paged } from "@media/ui/lib/pages";
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react";
import { useState } from "react";

import { creditText } from "@/components/library/artist-credits";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { MEDIA_BASE_URL } from "@/env";
import { formatDuration } from "@/lib/format";
import { useSignOut } from "@/session/session";
import { guestPages } from "./pages";

type Item = Parameters<PlatformSdk["music"]["playback"]["get"]>[0]["item"];

type Detail = Awaited<ReturnType<PlatformSdk["music"]["playback"]["get"]>>;

type Share = { readonly sharedBy: string; readonly expiresAt: number };

/**
 * Every artist a shared song or album credits, as text joined the way signed-in rows show it. A
 * share answers names without artist ids, so each name stands in for its artist's id.
 */
const creditedNames = ({ artist, credits = [] }: Detail): string =>
  creditText({
    artist,
    artistId: artist,
    credits: credits.map(({ name }) => ({ artistId: name, name })),
  });

/** A shell-free share whose reads and playback stay within the link's target. */
export function GuestItem({ item, ...share }: Share & { readonly item: Item }) {
  const platform = usePlatform();
  const result = usePlatformQuery(platform.music.playback.get, { item });

  return (
    <GuestRead pages={guestPages} state={result}>
      {(detail) =>
        detail.kind === "album" ? (
          <GuestAlbum detail={detail} {...share} />
        ) : (
          <GuestPlayer key={detail.id} detail={detail} tracks={[detail]} {...share} />
        )
      }
    </GuestRead>
  );
}

const wholeList = <Row,>(paged: Paged<Row>): QueryState<ReadonlyArray<Row>> => {
  if (paged.status === "failed") return { status: "error", error: paged.error, retry: paged.retry };

  if (paged.status === "loading") return { status: "loading" };

  if (paged.next.kind === "failed")
    return { status: "error", error: paged.next.error, retry: paged.next.retry };

  return paged.next.kind === "done"
    ? { status: "success", data: paged.rows }
    : { status: "loading" };
};

function GuestAlbum({
  detail,
  ...share
}: Share & { readonly detail: Extract<Detail, { readonly kind: "album" }> }) {
  const platform = usePlatform();

  const songs = useAllPages(platform.music.playback.tracks, (paginationOpts) => ({
    albumId: detail.id,
    paginationOpts,
  }));

  const list = wholeList(songs);

  return (
    <GuestRead pages={guestPages} state={list}>
      {(tracks) => (
        <GuestPlayer
          key={tracks.map((track) => track.id).join(":")}
          detail={detail}
          tracks={tracks}
          {...share}
        />
      )}
    </GuestRead>
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
              {creditedNames(detail)}
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
          <GuestProgress controller={controller} track={track} />
          {state.error === null ? null : <output className="block">{state.error}</output>}
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
  track,
}: {
  readonly controller: PlaybackController;
  readonly track: GuestTrack | undefined;
}) {
  const itemId = track?.id ?? null;
  const duration = track?.durationMs ?? 0;
  const position = useGuestPosition(controller, itemId);

  const [dragging, setDragging] = useState<{
    readonly itemId: GuestTrack["id"];
    readonly position: number;
  } | null>(null);

  const shown = Math.min(dragging?.itemId === itemId ? dragging.position : position, duration);

  return (
    <>
      <Slider
        aria-label="Seek"
        min={0}
        max={Math.max(duration, 1)}
        step={1000}
        value={shown}
        disabled={duration === 0}
        onValueChange={(value) => {
          if (itemId !== null) setDragging({ itemId, position: value });
        }}
        onValueCommitted={(value) => {
          setDragging(null);

          if (itemId !== null && controller.getSnapshot().current === itemId) {
            controller.seek(value);
          }
        }}
      />
      <div className="flex justify-between font-mono text-xs/xs text-text-muted">
        <span>{formatDuration(shown)}</span>
        <span>{formatDuration(duration)}</span>
      </div>
    </>
  );
}

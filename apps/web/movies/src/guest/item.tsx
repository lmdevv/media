import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { GuestRead } from "@media/ui/components/guest-share";
import { useAllPages } from "@media/ui/lib/pages";
import { useCallback, useMemo, useState } from "react";

import { PlayerScreen } from "@/components/player/player-screen";
import { useSleepTimer } from "@/components/player/use-sleep-timer";
import { useStillWatching } from "@/components/player/use-still-watching";
import { guestPages } from "@/guest/pages";
import { artworkUrl } from "@/lib/artwork";
import type { EpisodeId, TitleId, PlaybackDetail, MediaFileId } from "@/lib/catalog";
import { episodeCode, facts, formatRuntime } from "@/lib/format";
import { useSignOut } from "@/session/session";

type Item = Parameters<PlatformSdk["movies"]["playback"]["get"]>[0]["item"];

type Share = { readonly sharedBy: string; readonly expiresAt: number };

export function GuestItem({ item, ...share }: Share & { readonly item: Item }) {
  const platform = usePlatform();
  const [selected, setSelected] = useState<EpisodeId | null>(null);
  const target: Item = selected === null ? item : { type: "episode", id: selected };
  const result = usePlatformQuery(platform.movies.playback.get, { item: target });
  const [playing, setPlaying] = useState(false);

  const onBack = useCallback(() => {
    setSelected(null);
    setPlaying(false);
  }, []);

  return (
    <GuestRead pages={guestPages} state={result}>
      {(detail) =>
        playing && detail.versions.length > 0 ? (
          <GuestPlayer
            key={`${detail.titleId}:${detail.episode?.id ?? ""}`}
            detail={detail}
            version={item.type === "file" ? item.id : undefined}
            onBack={onBack}
          />
        ) : (
          <GuestTitle
            detail={detail}
            show={item.type === "title" && detail.kind === "show"}
            onPlay={() => setPlaying(true)}
            onEpisode={(id) => {
              setSelected(id);
              setPlaying(true);
            }}
            {...share}
          />
        )
      }
    </GuestRead>
  );
}

function GuestTitle({
  detail,
  show,
  sharedBy,
  expiresAt,
  onPlay,
  onEpisode,
}: Share & {
  readonly detail: PlaybackDetail;
  readonly show: boolean;
  readonly onPlay: () => void;
  readonly onEpisode: (id: EpisodeId) => void;
}) {
  const leave = useSignOut();
  const episode = detail.episode;
  const runtime = episode?.runtimeMs ?? detail.runtimeMs;

  const image = artworkUrl(
    episode?.still ?? detail.artwork.backdrop ?? detail.artwork.poster,
    "backdrop",
  );

  return (
    <main className="min-h-svh bg-page pb-16 text-text">
      {image === undefined ? null : (
        <img src={image} alt="" className="max-h-guest-artwork w-full object-cover" />
      )}
      <section className="mx-auto flex max-w-content flex-col gap-5 px-5 py-10 md:px-16">
        <p className="text-body/body text-text-muted">
          Shared by {sharedBy} · Ends {new Date(expiresAt).toLocaleString()}
        </p>
        <h1 className="text-title/title font-bold tracking-display">{detail.name}</h1>
        {episode === null ? null : (
          <h2 className="text-heading/heading font-semibold">
            {episodeCode(episode)} · {episode.name}
          </h2>
        )}
        <p className="text-body/body text-text-muted">
          {facts(detail.year, runtime === null ? null : formatRuntime(runtime))}
        </p>
        <p className="max-w-dialog text-body/body">{episode?.overview ?? detail.overview}</p>
        {detail.versions.length > 0 ? (
          <Button className="self-start" onClick={onPlay}>
            Play
          </Button>
        ) : null}
        {episode !== null && detail.versions.length === 0 ? (
          <output className="block">This episode isn't available</output>
        ) : null}
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            void leave().catch(() => undefined);
          }}
        >
          Leave
        </Button>
        {show ? <GuestEpisodes titleId={detail.titleId} onPlay={onEpisode} /> : null}
      </section>
    </main>
  );
}

function GuestPlayer({
  detail,
  version,
  onBack,
}: {
  readonly detail: PlaybackDetail;
  readonly version: MediaFileId | undefined;
  readonly onBack: () => void;
}) {
  const [opened] = useState(detail);
  const guest = useMemo(() => ({ detail: opened, onBack }), [opened, onBack]);
  const sleepTimer = useSleepTimer();
  const stillWatching = useStillWatching(onBack);

  return (
    <PlayerScreen
      titleId={opened.titleId}
      episodeId={opened.episode?.id}
      version={version}
      start="resume"
      guest={guest}
      sleepTimer={sleepTimer}
      stillWatching={stillWatching}
    />
  );
}

function GuestEpisodes({
  titleId,
  onPlay,
}: {
  readonly titleId: TitleId;
  readonly onPlay: (id: EpisodeId) => void;
}) {
  const platform = usePlatform();

  const seasons = useAllPages(platform.movies.playback.seasons, (paginationOpts) => ({
    titleId,
    paginationOpts,
  }));

  const [picked, setPicked] = useState<number | null>(null);

  if (seasons.status === "failed") return <Button onClick={seasons.retry}>Try again</Button>;

  if (seasons.status !== "ready") return <output className="block">Loading episodes…</output>;
  const season = picked ?? seasons.rows[0]?.seasonNumber;

  return (
    <section aria-label="Episodes" className="flex flex-col gap-5">
      <label className="text-body/body">
        Season{" "}
        <select
          className="bg-surface px-3 py-2 text-text"
          value={season}
          onChange={(event) => setPicked(Number(event.target.value))}
        >
          {seasons.rows.map((row) => (
            <option key={row.seasonNumber} value={row.seasonNumber}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      {seasons.next.kind === "more" ? (
        <Button onClick={seasons.next.load}>More seasons</Button>
      ) : null}
      {season === undefined ? null : (
        <Season key={season} titleId={titleId} seasonNumber={season} onPlay={onPlay} />
      )}
    </section>
  );
}

function Season({
  titleId,
  seasonNumber,
  onPlay,
}: {
  readonly titleId: TitleId;
  readonly seasonNumber: number;
  readonly onPlay: (id: EpisodeId) => void;
}) {
  const platform = usePlatform();

  const episodes = useAllPages(platform.movies.playback.episodes, (paginationOpts) => ({
    titleId,
    seasonNumber,
    paginationOpts,
  }));

  if (episodes.status === "failed") return <Button onClick={episodes.retry}>Try again</Button>;

  if (episodes.status !== "ready") return <output className="block">Loading episodes…</output>;

  return (
    <>
      <ul className="flex flex-col gap-4">
        {episodes.rows.map((episode) => (
          <li key={episode.id}>
            <button
              type="button"
              className="flex w-full cursor-pointer flex-col gap-2 rounded-control px-4 py-3 text-left hover:bg-surface"
              onClick={() => onPlay(episode.id)}
            >
              <span>
                {episodeCode(episode)} · {episode.name}
              </span>
              <span className="text-text-muted">{episode.overview}</span>
            </button>
          </li>
        ))}
      </ul>
      {episodes.next.kind === "more" ? (
        <Button onClick={episodes.next.load}>More episodes</Button>
      ) : null}
    </>
  );
}

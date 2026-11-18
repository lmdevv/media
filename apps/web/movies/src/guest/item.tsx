import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { GuestUnavailable } from "@media/ui/components/guest-unavailable";
import { useAllPages } from "@media/ui/lib/pages";
import { useState } from "react";

import { PlayerScreen } from "@/components/player/player-screen";
import { artworkUrl } from "@/lib/artwork";
import type { EpisodeId, TitleId } from "@/lib/catalog";
import { episodeCode, facts, formatRuntime } from "@/lib/format";
import { useSignOut } from "@/session/session";
import { BlankPage } from "@/session/redirect";

type Item = Parameters<PlatformSdk["movies"]["playback"]["get"]>[0]["item"];

export function GuestItem({
  item,
  sharedBy,
  expiresAt,
}: {
  readonly item: Item;
  readonly sharedBy: string;
  readonly expiresAt: number;
}) {
  const platform = usePlatform();
  const leave = useSignOut();
  const [selected, setSelected] = useState<EpisodeId | null>(null);
  const target: Item = selected === null ? item : { type: "episode", id: selected };
  const result = usePlatformQuery(platform.movies.playback.get, { item: target });
  const [playing, setPlaying] = useState(false);

  if (result.status === "loading") return <BlankPage />;

  if (result.status === "error") return <GuestUnavailable onLeave={leave} />;
  const detail = result.data;
  const show = item.type === "title" && detail.kind === "show";
  const episode = detail.episode;
  const runtime = episode?.runtimeMs ?? detail.runtimeMs;

  const image = artworkUrl(
    episode?.still ?? detail.artwork.backdrop ?? detail.artwork.poster,
    "backdrop",
  );

  if (playing && detail.versions.length > 0)
    return (
      <PlayerScreen
        key={`${detail.titleId}:${episode?.id ?? ""}`}
        titleId={detail.titleId}
        episodeId={episode?.id}
        version={item.type === "file" ? item.id : undefined}
        start="resume"
        guest={{ detail, onBack: () => setPlaying(false) }}
      />
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
          <Button className="self-start" onClick={() => setPlaying(true)}>
            Play
          </Button>
        ) : null}
        {episode !== null && detail.versions.length === 0 ? (
          <p role="status">This episode isn't available</p>
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
        {show ? (
          <GuestEpisodes
            titleId={detail.titleId}
            onPlay={(id) => {
              setSelected(id);
              setPlaying(true);
            }}
          />
        ) : null}
      </section>
    </main>
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

  if (seasons.status !== "ready") return <p role="status">Loading episodes…</p>;
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

  if (episodes.status !== "ready") return <p role="status">Loading episodes…</p>;

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

import type { Episode, SeasonEpisode, TitleDetail } from "@/lib/catalog";
import { allOfSeason, openingSeason, seasonPageArgs } from "@media/contracts/opening-season";
import { usePlatform } from "@media/sdk/react";
import { EpisodeRow } from "@media/ui/components/media-card";
import { ProgressBar } from "@media/ui/components/progress-bar";
import { useAllPages } from "@media/ui/lib/pages";
import { cn } from "@media/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { artworkUrl } from "@/lib/artwork";
import {
  episodeRuntimeFacts,
  facts,
  formatRuntime,
  plural,
  progressFraction,
  progressLabel,
} from "@/lib/format";
import { creditLines, formatDate } from "@/lib/metadata";

import { SelectMenu } from "./select-menu";
import { EpisodeMenu } from "./title-menu";

const NO_EPISODES: ReadonlyArray<SeasonEpisode> = [];

const episodeFacts = (episode: Episode): string | undefined => {
  const parts = facts(
    episode.rating === null ? null : `★ ${episode.rating.toFixed(1)}`,
    episode.available ? null : "File missing",
    progressLabel(episode.progress),
  );

  return parts === "" ? undefined : parts;
};

const episodeWhen = (episode: Episode): string | undefined => {
  const parts = facts(
    episode.airDate === null ? null : formatDate(episode.airDate),
    episode.runtimeMs === null ? null : formatRuntime(episode.runtimeMs),
  );

  return parts === "" ? undefined : parts;
};

const episodeCredits = (episode: SeasonEpisode): string | undefined => {
  const lines = creditLines(episode.credits, ["guest-star", "director", "writer"]).map(
    (line) => `${line.heading} ${line.people.map((person) => person.name).join(", ")}`,
  );

  return lines.length === 0 ? undefined : lines.join(" · ");
};

/** The season the server opens a show's episodes on, by the rule both share. */
const openingSeasonOf = (show: TitleDetail): number =>
  openingSeason({
    nextSeason: show.nextEpisode?.seasonNumber ?? null,
    seasons: show.seasons.map((season) => season.seasonNumber),
  }) ?? 1;

/**
 * The episodes section of a show's page. Starts on the season of the next episode, else the first
 * regular season, and stays on the season it opened on.
 */
export function Episodes({ show, phone }: { readonly show: TitleDetail; readonly phone: boolean }) {
  const platform = usePlatform();
  const opening = openingSeasonOf(show);
  const [openedOn] = useState(opening);
  const [seasonNumber, setSeasonNumber] = useState(openedOn);
  const [named, setNamed] = useState(false);
  const season = show.seasons.find((candidate) => candidate.seasonNumber === seasonNumber);
  // Only the season the list opened on reads the held page: a season the person picked stays
  // named, so its loaded pages stay when the opening season moves onto it.
  const held = !named && seasonNumber === openedOn;

  const episodes = useAllPages(platform.movies.titles.episodes, (paginationOpts) =>
    seasonPageArgs(show.id, seasonNumber, held, paginationOpts),
  );

  const ofSeason = episodes.status === "ready" && allOfSeason(episodes.rows, seasonNumber);

  // The held page moved to another season before the title said so: ask for this one by number.
  if (held && episodes.status === "ready" && !ofSeason) setNamed(true);

  const list = ofSeason ? episodes.rows : NO_EPISODES;
  const watched = list.filter((episode) => episode.progress?.watched === true).length;
  const nextId = show.nextEpisode?.id;

  const picker = (
    <SeasonPicker
      seasons={show.seasons}
      season={season}
      seasonNumber={seasonNumber}
      phone={phone}
      onChange={setSeasonNumber}
    />
  );

  const progress = ofSeason && list.length > 0 ? `${watched} of ${list.length} watched` : undefined;

  if (phone) {
    return (
      <section aria-label="Episodes" className="flex flex-col">
        <div className="flex items-center justify-between px-5 pt-5 pb-2">
          {picker}
          {progress === undefined ? null : (
            <p className="text-label/label text-text-muted">{progress}</p>
          )}
        </div>
        <ol className="flex flex-col gap-4 px-4 pt-2">
          {list.map((episode) => (
            <li key={episode.id}>
              <EpisodeMenu show={show} episode={episode}>
                <PhoneEpisode show={show} episode={episode} />
              </EpisodeMenu>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  return (
    <section aria-label="Episodes" className="w-full px-16 pt-2 pb-20">
      <div className="mx-auto flex max-w-content flex-col gap-6">
        <div className="flex items-end gap-8 border-b border-hairline">
          <div className="flex flex-col gap-3">
            <h2 className="text-body/label font-bold text-text">Episodes</h2>
            <span aria-hidden className="h-0.75 bg-accent" />
          </div>
        </div>
        <div className="flex items-center justify-between">
          {show.seasons.length === 0 ? <span /> : picker}
          {progress === undefined ? null : (
            <p className="text-label/label text-text-muted">{progress}</p>
          )}
        </div>
        <ol className="flex flex-col gap-2">
          {episodes.status === "loading"
            ? Array.from({ length: Math.min(season?.episodeCount ?? 4, 6) }, (_, index) => (
                <EpisodeSkeleton key={index} />
              ))
            : list.map((episode) => (
                <li key={episode.id}>
                  <EpisodeMenu show={show} episode={episode}>
                    <DesktopEpisode show={show} episode={episode} next={episode.id === nextId} />
                  </EpisodeMenu>
                </li>
              ))}
        </ol>
      </div>
    </section>
  );
}

function SeasonPicker({
  seasons,
  season,
  seasonNumber,
  phone,
  onChange,
}: {
  readonly seasons: TitleDetail["seasons"];
  readonly season: TitleDetail["seasons"][number] | undefined;
  readonly seasonNumber: number;
  readonly phone: boolean;
  readonly onChange: (seasonNumber: number) => void;
}) {
  const options = seasons.map((candidate) => ({
    value: String(candidate.seasonNumber),
    label: candidate.name,
    detail: plural(candidate.episodeCount, "episode", "episodes"),
  }));

  return (
    <SelectMenu
      label="Season"
      value={String(seasonNumber)}
      options={options}
      onChange={(value) => onChange(Number(value))}
      className={
        phone
          ? "gap-1.5 text-heading/heading font-bold tracking-tight"
          : "h-10 gap-3 border border-hairline bg-surface-raised pr-3.5 pl-4"
      }
    >
      <span className={phone ? undefined : "text-body/label font-semibold"}>
        {season?.name ?? `Season ${seasonNumber}`}
      </span>
      {phone || season === undefined ? null : (
        <span className="text-label/label text-text-muted">
          {plural(season.episodeCount, "episode", "episodes")}
        </span>
      )}
      <ChevronDownIcon className="size-4" strokeWidth={phone ? 2 : 1.75} aria-hidden />
    </SelectMenu>
  );
}

function EpisodeSkeleton() {
  return (
    <li aria-hidden className="flex items-center gap-6 p-4">
      <span className="w-7" />
      <span className="aspect-video w-44 rounded-poster bg-text/5" />
      <span className="flex grow flex-col gap-2">
        <span className="h-4 w-48 rounded-bar bg-text/6" />
        <span className="h-3 w-96 rounded-bar bg-text/5" />
      </span>
    </li>
  );
}

function DesktopEpisode({
  show,
  episode,
  next,
}: {
  readonly show: TitleDetail;
  readonly episode: SeasonEpisode;
  readonly next: boolean;
}) {
  return (
    <EpisodeRow
      number={episode.episodeNumber}
      title={episode.name}
      runtime={episodeWhen(episode)}
      synopsis={episode.overview ?? undefined}
      credits={episodeCredits(episode)}
      facts={episodeFacts(episode)}
      image={artworkUrl(episode.still, "card")}
      progress={progressFraction(episode.progress) ?? undefined}
      aria-current={next ? "true" : undefined}
      className={cn(
        "max-w-none gap-6 bg-transparent hover:bg-text/6",
        next && "bg-surface-raised hover:bg-surface-raised",
        !episode.available && "opacity-(--opacity-muted)",
      )}
      render={
        <Link
          to="/watch/$titleId"
          params={{ titleId: show.id }}
          search={{ episodeId: episode.id }}
        />
      }
    />
  );
}

function PhoneEpisode({
  show,
  episode,
}: {
  readonly show: TitleDetail;
  readonly episode: Episode;
}) {
  const fraction = progressFraction(episode.progress);
  const still = artworkUrl(episode.still, "card");

  return (
    <Link
      to="/watch/$titleId"
      params={{ titleId: show.id }}
      search={{ episodeId: episode.id }}
      className="flex items-center gap-3 rounded-control"
    >
      <span
        className="relative flex aspect-video w-33 shrink-0 items-end overflow-hidden rounded-control bg-surface-raised bg-cover bg-center"
        style={still === undefined ? undefined : { backgroundImage: `url("${still}")` }}
      >
        {fraction === null ? null : <ProgressBar value={fraction} className="h-0.75" />}
      </span>
      <span className="flex min-w-0 grow basis-0 flex-col gap-0.75">
        <span className="truncate text-body/5 font-semibold text-text">
          {episode.episodeNumber}. {episode.name}
        </span>
        <span className="text-label/label text-text-muted">{episodeRuntimeFacts(episode)}</span>
      </span>
    </Link>
  );
}

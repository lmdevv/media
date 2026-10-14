import type {
  AlbumCard as Album,
  ArtistCard as Artist,
  SearchResults,
  Track,
} from "@music/commands/models";
import { foldSearchText } from "@music/commands/search-text";
import { usePlayer } from "@music/player/react";
import { useRead } from "@music/sdk/react";
import { Chip } from "@music/ui/components/chip";
import { cn } from "@music/ui/lib/utils";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Match, Schema } from "effect";
import { PlayIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Artwork, PlayingBars } from "@/components/library/artwork";
import { usePlayAlbum, usePlayArtist, usePlayTracks } from "@/components/library/cards";
import { TrackMenu } from "@/components/playlists/track-menu";
import { SEARCH_INPUT_ID } from "@/components/shell/keyboard";
import { formatCount, formatDuration, plural } from "@/lib/format";

const SearchParams = Schema.Struct({ q: Schema.optionalKey(Schema.String) });

export const Route = createFileRoute("/_app/search")({
  validateSearch: Schema.toStandardSchemaV1(SearchParams),
  component: SearchPage,
});

const DEBOUNCE_MS = 120;

/** The search screen exists to type into its field, so the field takes focus on arrival. */
const focusOnMount = (input: HTMLInputElement | null): void => {
  input?.focus({ preventScroll: true });
};

const LIMIT = 24;

/** The value after it stops changing for `delayMs`. */
const useDebounced = (value: string, delayMs: number): string => {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);

    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
};

/** Results for the settled query, keeping the previous results visible while new ones load. */
/** Search results as shown: the last results while new ones load, and the query they match. */
interface ShownSearch {
  readonly results: SearchResults | null;
  readonly updating: boolean;
  readonly forQuery: string;
}

const useSearch = (query: string): ShownSearch => {
  const settled = useDebounced(query.trim(), DEBOUNCE_MS);
  const live = useRead("search", settled.length === 0 ? "skip" : { query: settled, limit: LIMIT });

  const [shown, setShown] = useState<{
    readonly results: SearchResults;
    readonly query: string;
  } | null>(null);

  useEffect(() => {
    if (live !== undefined) setShown({ results: live, query: settled });
  }, [live, settled]);

  if (query.trim().length === 0) return { results: null, updating: false, forQuery: "" };

  return {
    results: shown?.results ?? null,
    updating: live === undefined || settled !== query.trim(),
    forQuery: shown?.query ?? settled,
  };
};

const countResults = (results: SearchResults): number =>
  results.tracks.length + results.albums.length + results.artists.length;

function SearchPage() {
  const { q = "" } = Route.useSearch();
  const navigate = useNavigate();
  const { results, updating, forQuery } = useSearch(q);
  const total = results === null ? null : countResults(results);

  const setQuery = (value: string) =>
    void navigate({ to: "/search", search: { q: value }, replace: true });

  return (
    <div className="flex flex-col gap-5 px-5 pt-safe-top lg:gap-8 lg:px-12 lg:pt-8">
      <label className="hidden h-row-touch shrink-0 items-center gap-3.5 rounded-md border-field border-transparent bg-surface px-4.5 has-focus-visible:border-accent lg:flex">
        <SearchIcon aria-hidden className="size-5.5 text-text" />
        <input
          id={SEARCH_INPUT_ID}
          ref={focusOnMount}
          type="search"
          aria-label="Search your library"
          placeholder="Artists, songs, albums"
          value={q}
          onChange={(event) => setQuery(event.target.value)}
          className="h-full min-w-0 grow bg-transparent font-sans text-lg/md text-text outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
        />
        {total === null || q.trim().length === 0 ? null : (
          <span
            aria-live="polite"
            className="shrink-0 font-mono text-xs/xs tracking-mono text-text-muted"
          >
            {updating ? "SEARCHING…" : `${formatCount(total)} RESULTS`}
          </span>
        )}
      </label>
      <h1 className="font-sans text-phone-large-title leading-10.25 font-heavy tracking-tighter text-text lg:hidden">
        Search
      </h1>

      {q.trim().length === 0 ? (
        <p className="max-w-dialog font-sans text-md/md text-text-muted lg:pt-row">
          Search your songs, albums, and artists. Press / anywhere to come back here.
        </p>
      ) : results === null ? (
        <p className="font-sans text-md/md text-text-muted">Searching…</p>
      ) : total === 0 && !updating ? (
        <NoResults query={forQuery} onClear={() => setQuery("")} />
      ) : (
        <div
          className={cn("transition-opacity", updating && "opacity-(--opacity-muted)")}
          aria-busy={updating}
        >
          <DesktopResults results={results} query={forQuery} />
          <PhoneResults results={results} />
        </div>
      )}
    </div>
  );
}

function NoResults({ query, onClear }: { readonly query: string; readonly onClear: () => void }) {
  return (
    <div className="flex w-full max-w-dialog flex-col items-start gap-3 lg:pt-row">
      <h2 className="font-sans text-xl/xl font-heavy tracking-tight text-text">
        Not in your library
      </h2>
      <p className="font-sans text-md/md text-text-muted">
        Nothing matches “{query}” in titles, artists, or albums. [music] only searches music you
        own.
      </p>
      <div className="flex gap-2 pt-2">
        <Chip selected={false} onClick={onClear}>
          Clear search
        </Chip>
        <Link
          to="/settings/libraries"
          search={{}}
          className="flex h-9 items-center rounded-full border border-border px-4 font-sans text-sm/xs font-medium text-text hover:bg-surface"
        >
          Check library folders
        </Link>
      </div>
    </div>
  );
}

type TopResult =
  | { readonly kind: "artist"; readonly artist: Artist }
  | { readonly kind: "album"; readonly album: Album }
  | { readonly kind: "track"; readonly track: Track };

/**
 * How many of the query's words a name contains, ignoring case and accents as the server's search
 * does; ties keep artist, album, song order.
 */
const overlap = (name: string, query: string): number => {
  const folded = foldSearchText(name);

  return foldSearchText(query)
    .split(/\s+/)
    .filter((word) => word.length > 0 && folded.includes(word)).length;
};

const topResult = (results: SearchResults, query: string): TopResult | null => {
  const candidates: ReadonlyArray<{ readonly result: TopResult; readonly name: string }> = [
    ...results.artists
      .slice(0, 1)
      .map((artist) => ({ result: { kind: "artist", artist } as const, name: artist.name })),
    ...results.albums
      .slice(0, 1)
      .map((album) => ({ result: { kind: "album", album } as const, name: album.title })),
    ...results.tracks
      .slice(0, 1)
      .map((track) => ({ result: { kind: "track", track } as const, name: track.title })),
  ];

  let best: { readonly result: TopResult; readonly score: number } | null = null;

  for (const candidate of candidates) {
    const score = overlap(candidate.name, query);

    if (best === null || score > best.score) best = { result: candidate.result, score };
  }

  return best?.result ?? null;
};

function TopResultCard({
  result,
  results,
}: {
  readonly result: TopResult;
  readonly results: SearchResults;
}) {
  const playArtist = usePlayArtist();
  const playAlbum = usePlayAlbum();
  const playTracks = usePlayTracks();

  const card = Match.value(result).pipe(
    Match.when({ kind: "artist" }, ({ artist }) => ({
      title: artist.name,
      meta: `Artist · ${plural(artist.albumCount, "album")}`,
      art: <Artwork url={artist.artUrl} seed={artist.id} round className="size-24" />,
      link: (
        <Link
          to="/artists/$artistId"
          params={{ artistId: artist.id }}
          aria-label={artist.name}
          className="absolute inset-0 rounded-lg"
        />
      ),
      play: () => void playArtist(artist.id),
    })),
    Match.when({ kind: "album" }, ({ album }) => ({
      title: album.title,
      meta: `Album · ${album.artist}`,
      art: <Artwork url={album.artUrl} seed={album.id} className="size-24 rounded-md" />,
      link: (
        <Link
          to="/albums/$albumId"
          params={{ albumId: album.id }}
          aria-label={album.title}
          className="absolute inset-0 rounded-lg"
        />
      ),
      play: () => void playAlbum(album.id),
    })),
    Match.when({ kind: "track" }, ({ track }) => ({
      title: track.title,
      meta: `Song · ${track.artist}`,
      art: <Artwork url={track.artUrl} seed={track.albumId} className="size-24 rounded-md" />,
      link: null,
      play: () => void playTracks(results.tracks, { index: 0 }),
    })),
    Match.exhaustive,
  );

  return (
    <div className="relative flex h-55 flex-col justify-end gap-4 rounded-lg bg-surface p-5 hover:bg-border/60 dark:hover:bg-surface-raised">
      {card.link}
      {card.art}
      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-sans text-xl leading-8.5 font-heavy tracking-tight text-text">
            {card.title}
          </span>
          <span className="truncate font-sans text-sm/xs text-text-muted">{card.meta}</span>
        </div>
        <button
          type="button"
          aria-label={`Play ${card.title}`}
          onClick={card.play}
          className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-text text-text-inverse outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <PlayIcon className="size-4.5 translate-x-px" fill="currentColor" strokeWidth={0} />
        </button>
      </div>
    </div>
  );
}

function SongRow({
  track,
  tracks,
  index,
}: {
  readonly track: Track;
  readonly tracks: ReadonlyArray<Track>;
  readonly index: number;
}) {
  const player = usePlayer();
  const play = usePlayTracks();
  const current = player.track?.id === track.id;

  return (
    <div
      className="group/row relative flex h-13 shrink-0 items-center gap-3 rounded-sm px-2 hover:bg-surface"
      onDoubleClick={() => void play(tracks, { index })}
    >
      <Artwork url={track.artUrl} seed={track.albumId} className="size-row rounded-xs">
        <button
          type="button"
          aria-label={`Play ${track.title}`}
          onClick={() => void play(tracks, { index })}
          className={cn(
            "absolute inset-0 flex items-center justify-center bg-dark-canvas/30 text-dark-text outline-none",
            current
              ? "bg-dark-canvas/35"
              : "pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
          )}
        >
          {current ? (
            <PlayingBars />
          ) : (
            <PlayIcon className="size-4" fill="currentColor" strokeWidth={0} />
          )}
        </button>
      </Artwork>
      <span className="flex min-w-0 grow flex-col gap-px">
        <span
          className={cn("truncate font-sans text-base/sm text-text", current && "font-semibold")}
        >
          {track.title}
        </span>
        <span className="truncate font-sans text-sm/xs text-text-muted">
          {track.artist} · {track.album}
        </span>
      </span>
      <span className="font-mono text-sm/xs text-text-muted group-hover/row:hidden">
        {formatDuration(track.durationMs)}
      </span>
      <TrackMenu track={track} className="hidden group-hover/row:flex data-popup-open:flex" />
    </div>
  );
}

function DesktopResults({
  results,
  query,
}: {
  readonly results: SearchResults;
  readonly query: string;
}) {
  const top = topResult(results, query);

  return (
    <div className="hidden flex-col gap-8 lg:flex">
      <div className="flex gap-8">
        {top === null ? null : (
          <section className="flex w-95 shrink-0 flex-col gap-3.5">
            <h2 className="font-sans text-lg/md font-semibold tracking-tight text-text">
              Top result
            </h2>
            <TopResultCard result={top} results={results} />
          </section>
        )}
        {results.tracks.length === 0 ? null : (
          <section className="flex min-w-0 grow flex-col gap-1.5">
            <h2 className="pb-2 font-sans text-lg/md font-semibold tracking-tight text-text">
              Songs
            </h2>
            {results.tracks.slice(0, 4).map((track, index) => (
              <SongRow key={track.id} track={track} tracks={results.tracks} index={index} />
            ))}
          </section>
        )}
      </div>
      {results.albums.length === 0 ? null : (
        <section className="flex flex-col gap-3.5">
          <h2 className="font-sans text-lg/md font-semibold tracking-tight text-text">Albums</h2>
          <div className="flex gap-5 overflow-x-auto pb-1">
            {results.albums.map((album) => (
              <Link
                key={album.id}
                to="/albums/$albumId"
                params={{ albumId: album.id }}
                className="flex w-42 shrink-0 flex-col gap-2.5"
              >
                <Artwork url={album.artUrl} seed={album.id} className="size-42 rounded-md" />
                <span className="flex flex-col gap-0.5">
                  <span className="truncate font-sans text-base/sm font-medium text-text">
                    {album.title}
                  </span>
                  <span className="truncate font-sans text-sm/xs text-text-muted">
                    {album.year === null ? album.artist : `${album.artist} · ${album.year}`}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {results.artists.length > 1 ? (
        <section className="flex flex-col gap-3.5">
          <h2 className="font-sans text-lg/md font-semibold tracking-tight text-text">Artists</h2>
          <div className="flex gap-5 overflow-x-auto pb-1">
            {results.artists.map((artist) => (
              <Link
                key={artist.id}
                to="/artists/$artistId"
                params={{ artistId: artist.id }}
                className="flex w-35 shrink-0 flex-col items-center gap-2.5"
              >
                <Artwork url={artist.artUrl} seed={artist.id} round className="size-35" />
                <span className="max-w-full truncate font-sans text-base/sm font-medium text-text">
                  {artist.name}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      {results.tracks.length > 4 ? (
        <section className="flex flex-col gap-1.5">
          <h2 className="pb-2 font-sans text-lg/md font-semibold tracking-tight text-text">
            More songs
          </h2>
          {results.tracks.slice(4).map((track, index) => (
            <SongRow key={track.id} track={track} tracks={results.tracks} index={index + 4} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

type Scope = "all" | "songs" | "albums" | "artists";

function PhoneResults({ results }: { readonly results: SearchResults }) {
  const [scope, setScope] = useState<Scope>("all");
  const play = usePlayTracks();

  const rows = [
    ...(scope === "all" || scope === "artists"
      ? results.artists.map((artist) => ({
          key: artist.id,
          node: (
            <Link
              to="/artists/$artistId"
              params={{ artistId: artist.id }}
              className="flex h-row-touch items-center gap-3"
            >
              <Artwork url={artist.artUrl} seed={artist.id} round className="size-11" />
              <span className="flex min-w-0 flex-col gap-px">
                <span className="truncate font-sans text-md/base text-text">{artist.name}</span>
                <span className="font-sans text-sm/xs text-text-muted">Artist</span>
              </span>
            </Link>
          ),
        }))
      : []),
    ...(scope === "all" || scope === "songs"
      ? results.tracks.map((track, index) => ({
          key: track.id,
          node: (
            <button
              type="button"
              onClick={() => void play(results.tracks, { index })}
              className="flex h-row-touch w-full items-center gap-3 text-left"
            >
              <Artwork url={track.artUrl} seed={track.albumId} className="size-11 rounded-xs" />
              <span className="flex min-w-0 flex-col gap-px">
                <span className="truncate font-sans text-md/base text-text">{track.title}</span>
                <span className="truncate font-sans text-sm/xs text-text-muted">
                  Song · {track.artist}
                </span>
              </span>
            </button>
          ),
        }))
      : []),
    ...(scope === "all" || scope === "albums"
      ? results.albums.map((album) => ({
          key: album.id,
          node: (
            <Link
              to="/albums/$albumId"
              params={{ albumId: album.id }}
              className="flex h-row-touch items-center gap-3"
            >
              <Artwork url={album.artUrl} seed={album.id} className="size-11 rounded-xs" />
              <span className="flex min-w-0 flex-col gap-px">
                <span className="truncate font-sans text-md/base text-text">{album.title}</span>
                <span className="truncate font-sans text-sm/xs text-text-muted">
                  Album{album.year === null ? "" : ` · ${album.year}`}
                </span>
              </span>
            </Link>
          ),
        }))
      : []),
  ];

  return (
    <div className="flex flex-col gap-5 lg:hidden">
      <div role="group" aria-label="Show" className="flex gap-2 overflow-x-auto">
        {(["all", "songs", "albums", "artists"] as const).map((value) => (
          <Chip
            key={value}
            size="sm"
            selected={scope === value}
            onClick={() => setScope(value)}
            className="px-3.5"
          >
            {value === "all" ? "All" : value.charAt(0).toUpperCase() + value.slice(1)}
          </Chip>
        ))}
      </div>
      <div className="flex flex-col">
        {rows.length === 0 ? (
          <p className="font-sans text-md/md text-text-muted">No {scope} match.</p>
        ) : (
          rows.map((row) => <div key={row.key}>{row.node}</div>)
        )}
      </div>
    </div>
  );
}

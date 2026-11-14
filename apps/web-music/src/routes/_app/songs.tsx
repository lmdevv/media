import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createFileRoute } from "@tanstack/react-router";
import { SearchIcon, ShuffleIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { PageHeader, usePlayTracks } from "@/components/library/cards";
import { useMoreOnView } from "@/components/library/paged";
import { TrackList, TrackListSkeleton } from "@/components/library/track-list";
import { toastFailure } from "@/lib/action";
import { formatTotal, plural } from "@/lib/format";
import { readPages, usePaged } from "@/lib/pages";
import { useMusic, useRead } from "@/lib/platform";
import { useHeld } from "@/lib/use-held";

export const Route = createFileRoute("/_app/songs")({ component: SongsPage });

const PAGE_SIZE = 100;

const SHUFFLE_LIMIT = 2000;

function SongsPage() {
  const music = useMusic();
  const home = useRead(music.library.home, {});
  const [filter, setFilter] = useState("");
  const query = useDeferredValue(filter.trim());
  const play = usePlayTracks();
  const [shuffling, setShuffling] = useState(false);

  const shuffleAll = async () => {
    setShuffling(true);

    try {
      const tracks = await readPages(
        (paginationOpts) => music.tracks.list({ paginationOpts }),
        SHUFFLE_LIMIT,
      );

      await play(tracks, { shuffle: true });
    } catch (cause) {
      toastFailure(cause);
    } finally {
      setShuffling(false);
    }
  };

  return (
    <div className="flex flex-col gap-7 px-5 pt-safe-top lg:px-12 lg:pt-row">
      <PageHeader
        eyebrow={
          home === undefined
            ? null
            : `${plural(home.stats.tracks, "song")} · ${formatTotal(home.stats.durationMs)} of music`
        }
        title="Songs"
        actions={
          <div className="flex w-full items-center gap-2 lg:w-auto">
            <Input
              size="sm"
              type="search"
              aria-label="Filter songs"
              placeholder="Filter songs"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              fieldClassName="h-9 min-w-0 shrink grow rounded-sm lg:w-sidebar lg:grow-0"
              start={<SearchIcon aria-hidden />}
            />
            <Button
              variant="solid"
              size="sm"
              className="pl-3"
              pending={shuffling}
              onClick={() => void shuffleAll()}
            >
              <ShuffleIcon />
              Shuffle all
            </Button>
          </div>
        }
      />
      {query.length > 0 ? <FilteredSongs query={query} /> : <AllSongs />}
    </div>
  );
}

function FilteredSongs({ query }: { readonly query: string }) {
  const results = useRead(useMusic().library.search, { query, limit: 50 });
  const shown = useHeld(results);

  if (shown === undefined) return <TrackListSkeleton />;

  if (shown.tracks.length === 0) {
    return <p className="font-sans text-md/md text-text-muted">No songs match “{query}”.</p>;
  }

  return (
    <div
      className={results === undefined ? "opacity-(--opacity-muted) transition-opacity" : undefined}
    >
      <TrackList tracks={shown.tracks} variant="list" label={`Songs matching ${query}`} />
    </div>
  );
}

function AllSongs() {
  const music = useMusic();
  const paged = usePaged(music.tracks.list, (paginationOpts) => ({ paginationOpts }), PAGE_SIZE);
  const sentinel = useMoreOnView(paged);

  if (paged.status === "loading") return <TrackListSkeleton />;

  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.rows.length === 0 && paged.next.kind === "done") {
    return (
      <p className="font-sans text-md/md text-text-muted">
        No songs yet. They appear here as your library is scanned.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      <TrackList tracks={paged.rows} variant="list" label="Songs" windowing="always" />
      {paged.next.kind === "loading" ? <TrackListSkeleton /> : null}
      {sentinel.more ? <div ref={sentinel.ref} aria-hidden className="h-px" /> : null}
    </div>
  );
}

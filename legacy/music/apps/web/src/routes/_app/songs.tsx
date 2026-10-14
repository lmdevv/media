import { useRead, useReadOnce } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { Input } from "@music/ui/components/input";
import { createFileRoute } from "@tanstack/react-router";
import { SearchIcon, ShuffleIcon } from "lucide-react";
import { useDeferredValue, useEffect, useRef, useState } from "react";

import { PageHeader, usePlayTracks } from "@/components/library/cards";
import { useHeldPage, usePageChain, useReportPage } from "@/components/library/paged";
import type { PageResult } from "@/components/library/paged";
import { TrackList, TrackListSkeleton } from "@/components/library/track-list";
import { toastFailure } from "@/lib/action";
import { formatTotal, plural } from "@/lib/format";
import { readPages } from "@/lib/read-pages";

export const Route = createFileRoute("/_app/songs")({ component: SongsPage });

const PAGE_SIZE = 100;

const SHUFFLE_LIMIT = 2000;

function SongsPage() {
  const home = useRead("library.home", {});
  const [filter, setFilter] = useState("");
  const query = useDeferredValue(filter.trim());
  const readPage = useReadOnce("tracks.list");
  const play = usePlayTracks();
  const [shuffling, setShuffling] = useState(false);

  const shuffleAll = async () => {
    setShuffling(true);

    try {
      const tracks = await readPages((cursor) => readPage({ cursor, limit: 200 }), SHUFFLE_LIMIT);

      await play(tracks, { shuffle: true });
    } catch (cause) {
      toastFailure(cause);
    } finally {
      setShuffling(false);
    }
  };

  return (
    <div className="flex flex-col gap-7 px-5 pt-[max(16px,env(safe-area-inset-top))] lg:px-12 lg:pt-row">
      <PageHeader
        eyebrow={
          home === undefined
            ? undefined
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
  const results = useRead("search", { query, limit: 50 });
  const [shown, setShown] = useState(results);

  useEffect(() => {
    if (results !== undefined) setShown(results);
  }, [results]);

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
  const chain = usePageChain();

  return (
    <div className="flex flex-col">
      {chain.cursors.map((cursor, index) => (
        <SongPage
          key={cursor ?? "first"}
          cursor={cursor}
          end={chain.cursors[index + 1] ?? null}
          header={index === chain.firstFilled}
          last={index === chain.cursors.length - 1}
          onMore={chain.more}
          onReport={chain.report}
        />
      ))}
      {chain.empty ? (
        <p className="font-sans text-md/md text-text-muted">
          No songs yet. They appear here as your library is scanned.
        </p>
      ) : null}
    </div>
  );
}

function SongPage({
  cursor,
  end,
  header,
  last,
  onMore,
  onReport,
}: {
  readonly cursor: string | null;
  /** Where the next page starts, once it exists. */
  readonly end: string | null;
  /** The first page that shows songs carries the list's column header. */
  readonly header: boolean;
  readonly last: boolean;
  readonly onMore: (cursor: string) => void;
  readonly onReport: (cursor: string | null, page: PageResult<unknown>) => void;
}) {
  const page = useHeldPage(useRead("tracks.list", { cursor, end, limit: PAGE_SIZE }));
  useReportPage(cursor, page, onReport);
  const sentinel = useRef<HTMLDivElement>(null);
  const more = page !== undefined && !page.done && last ? page.cursor : null;

  useEffect(() => {
    const node = sentinel.current;

    if (more === null || node === null) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onMore(more);
      },
      { rootMargin: "600px" },
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [more, onMore]);

  if (page === undefined) return <TrackListSkeleton />;

  // An empty page renders only its sentinel, which stays in view and loads the next one.
  return (
    <>
      {page.items.length === 0 ? null : (
        <TrackList tracks={page.items} variant="list" label="Songs" header={header} />
      )}
      {more === null ? null : <div ref={sentinel} aria-hidden className="h-px" />}
    </>
  );
}

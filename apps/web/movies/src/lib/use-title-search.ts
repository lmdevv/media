import { orSkip } from "@/lib/query-state";
import type { PersonCard, TitleCard } from "@/lib/catalog";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { useEffect, useState } from "react";

const SEARCH_DELAY_MS = 150;

const SEARCH_LIMIT = 24;

const PEOPLE_LIMIT = 6;

/** Live title results for what someone is typing. */
export interface TitleSearch {
  /** The trimmed query the results belong to; empty before anything is typed. */
  readonly query: string;
  /** Results for `query`, or the previous results while the next search runs. */
  readonly results: ReadonlyArray<TitleCard>;
  /** Cast and crew whose names match `query`, credited on titles the person may see. */
  readonly people: ReadonlyArray<PersonCard>;
  /** True until the first results for a non-empty query arrive. */
  readonly loading: boolean;
}

interface Settled {
  readonly query: string;
  readonly results: ReadonlyArray<TitleCard>;
  readonly people: ReadonlyArray<PersonCard>;
}

const NO_TITLES: ReadonlyArray<TitleCard> = [];

const NO_PEOPLE: ReadonlyArray<PersonCard> = [];

const NOTHING: Settled = { query: "", results: NO_TITLES, people: NO_PEOPLE };

const sameSettled = (a: Settled, b: Settled): boolean =>
  a.query === b.query && a.results === b.results && a.people === b.people;

/**
 * Searches the person's titles and people as `text` changes, after a short pause, keeping the
 * previous results on screen until the next ones arrive so lists do not flicker. A kid gets only
 * the titles their limits allow; the core filters them.
 */
export const useTitleSearch = (text: string): TitleSearch => {
  const platform = usePlatform();
  const [query, setQuery] = useState(() => text.trim());

  useEffect(() => {
    const next = text.trim();
    const timer = setTimeout(() => setQuery(next), next === "" ? 0 : SEARCH_DELAY_MS);

    return () => clearTimeout(timer);
  }, [text]);

  const search = usePlatformQuery(
    platform.movies.titles.search,
    ...orSkip(query === "" ? null : { query, limit: SEARCH_LIMIT }),
  );

  const people = usePlatformQuery(
    platform.movies.people.search,
    ...orSkip(query === "" ? null : { query, limit: PEOPLE_LIMIT }),
  );

  const found = people.status === "success" ? people.data : NO_PEOPLE;

  const current: Settled | null =
    query === ""
      ? NOTHING
      : search.status === "success"
        ? { query, results: search.data, people: found }
        : search.status === "error"
          ? { query, results: NO_TITLES, people: found }
          : null;

  const [previous, setPrevious] = useState<Settled>(NOTHING);

  if (current !== null && !sameSettled(current, previous)) setPrevious(current);

  const settled = current ?? previous;

  return {
    query: settled.query,
    results: settled.results,
    people: settled.people,
    loading: query !== "" && settled.query !== query,
  };
};

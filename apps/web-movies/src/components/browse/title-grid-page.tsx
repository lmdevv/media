import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { Chip } from "@media/ui/components/chip";
import { usePages } from "@media/ui/lib/pages";
import type { PageOpts, Paged } from "@media/ui/lib/pages";
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { TitleCard, TitleKind, TitleSort } from "@/lib/catalog";
import { plural, titleFacts } from "@/lib/format";
import { useLatest } from "@/lib/use-latest";
import { decadesUntil } from "@/lib/metadata";

import { PosterGridSkeleton } from "./skeletons";
import { SelectMenu } from "./select-menu";
import type { SelectOption } from "./select-menu";
import { newBadge } from "./new-badge";
import { TitlePosterCard } from "./title-cards";

const PAGE_SIZE = 60;

const FILTERED_PAGE_SIZE = 100;

const GENRE_CHIPS = 8;

const SORTS: ReadonlyArray<SelectOption<TitleSort>> = [
  { value: "added", label: "Recently added" },
  { value: "name", label: "Name" },
  { value: "year", label: "Year" },
];

const ANY = "any";

const DECADES: ReadonlyArray<SelectOption<string>> = [
  { value: ANY, label: "Any year" },
  ...decadesUntil(new Date().getFullYear()).map((decade) => ({
    value: String(decade.from),
    label: decade.label,
  })),
];

const SCORES: ReadonlyArray<SelectOption<string>> = [
  { value: ANY, label: "Any score" },
  { value: "8", label: "8+" },
  { value: "7", label: "7+" },
  { value: "6", label: "6+" },
];

interface GridFilters {
  readonly sort: TitleSort;
  readonly genre: string | null;
  readonly decade: string;
  readonly score: string;
}

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

type ListArgs = Mutable<Parameters<PlatformSdk["movies"]["titles"]["list"]>[0]>;

const isNarrowed = (filters: GridFilters): boolean =>
  filters.genre !== null || filters.decade !== ANY || filters.score !== ANY;

const listArgs = (
  kind: TitleKind | undefined,
  filters: GridFilters,
  paginationOpts: PageOpts,
): ListArgs => {
  const args: ListArgs = {
    sort: filters.sort,
    paginationOpts: {
      ...paginationOpts,
      numItems: isNarrowed(filters) ? FILTERED_PAGE_SIZE : PAGE_SIZE,
    },
  };

  if (kind !== undefined) args.kind = kind;

  if (filters.genre !== null) args.genre = filters.genre;

  if (filters.decade !== ANY) {
    args.yearFrom = Number(filters.decade);
    args.yearTo = Number(filters.decade) + 9;
  }

  if (filters.score !== ANY) args.minRating = Number(filters.score);

  return args;
};

interface NearViewport {
  readonly near: { readonly current: boolean };
  readonly ref: (element: HTMLElement | null) => (() => void) | undefined;
}

const useNearViewport = (onNear: () => void): NearViewport => {
  const latest = useLatest(onNear);
  const near = useRef(false);

  const ref = useCallback(
    (element: HTMLElement | null) => {
      if (element === null) return undefined;

      const observer = new IntersectionObserver(
        (entries) => {
          near.current = entries.some((entry) => entry.isIntersecting);

          if (near.current) latest.current();
        },
        { rootMargin: "600px 0px" },
      );

      observer.observe(element);

      return () => {
        observer.disconnect();
        near.current = false;
      };
    },
    [latest],
  );

  return { near, ref };
};

/** Page heading: a heavy title with a mono count, and controls on the right. */
export function GridHeader({
  title,
  count,
  controls,
}: {
  readonly title: string;
  readonly count?: string | undefined;
  readonly controls?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4 pt-2 pb-5 max-md:hidden md:pt-9 md:pb-6">
      <div className="flex items-baseline gap-3.5">
        <h1 className="text-title/title font-heavy tracking-display text-text">{title}</h1>
        {count === undefined ? null : (
          <p className="font-mono text-label/label text-text-muted">{count}</p>
        )}
      </div>
      {controls}
    </div>
  );
}

/** The responsive poster grid: two columns on phones, 168px posters on desktops. */
export function PosterGrid({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-[repeat(auto-fill,minmax(var(--spacing-42),1fr))] md:gap-x-5.5 md:gap-y-8">
      {children}
    </div>
  );
}

function FilterMenu<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<SelectOption<Value>>;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <SelectMenu
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      className="h-9 gap-2.5 border border-hairline pr-3 pl-3.5"
    >
      <span className="text-label/label text-text-muted">{label}</span>
      <span className="text-label/label font-semibold">
        {options.find((option) => option.value === value)?.label}
      </span>
      <ChevronDownIcon className="size-4" strokeWidth={1.75} aria-hidden />
    </SelectMenu>
  );
}

function GenreChips({
  kind,
  genre,
  onChange,
}: {
  readonly kind: TitleKind | undefined;
  readonly genre: string | null;
  readonly onChange: (genre: string | null) => void;
}) {
  const platform = usePlatform();

  const genres = usePlatformQuery(
    platform.movies.titles.genres,
    kind === undefined ? {} : { kind },
  );

  const names = genres.status === "success" ? genres.data.slice(0, GENRE_CHIPS) : [];

  if (names.length < 2) return null;

  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-6 scrollbar-none md:mx-0 md:px-0 md:pb-8">
      <Chip selected={genre === null} onClick={() => onChange(null)}>
        All
      </Chip>
      {names.map(({ name }) => (
        <Chip key={name} selected={genre === name} onClick={() => onChange(name)}>
          {name}
        </Chip>
      ))}
    </div>
  );
}

/**
 * Every title of `kind` (or of every kind) the person may see, optionally only `genre`'s. A fixed
 * genre hides the genre chips; the sort, decade, and score menus filter on the server.
 */
export function TitleGridPage({
  kind,
  genre: fixedGenre,
  heading,
}: {
  readonly kind?: TitleKind | undefined;
  readonly genre?: string | undefined;
  readonly heading: string;
}) {
  const platform = usePlatform();

  const [filters, setFilters] = useState<GridFilters>({
    sort: "added",
    genre: fixedGenre ?? null,
    decade: ANY,
    score: ANY,
  });

  const titles = usePages(platform.movies.titles.list, (paginationOpts) =>
    listArgs(kind, filters, paginationOpts),
  );

  const next = titles.status === "ready" ? titles.next : null;
  const load = next?.kind === "more" ? next.load : null;
  const end = useNearViewport(() => load?.());
  const nearEnd = end.near;

  useEffect(() => {
    if (nearEnd.current) load?.();
  }, [load, nearEnd]);

  const changeFilters = (changes: Partial<GridFilters>): void => {
    setFilters((current) => ({ ...current, ...changes }));
  };

  const complete = next?.kind === "done";
  const now = Date.now();

  const noun = kind === "show" ? ["show", "shows"] : ["title", "titles"];

  return (
    <div className="mx-auto box-content max-w-content px-4 md:px-16">
      <GridHeader
        title={heading}
        count={
          complete && titles.status === "ready"
            ? plural(titles.rows.length, noun[0] ?? "", noun[1] ?? "")
            : undefined
        }
        controls={
          <div className="flex items-center gap-2">
            <FilterMenu
              label="Year"
              value={filters.decade}
              options={DECADES}
              onChange={(decade) => changeFilters({ decade })}
            />
            <FilterMenu
              label="Score"
              value={filters.score}
              options={SCORES}
              onChange={(score) => changeFilters({ score })}
            />
            <FilterMenu
              label="Sort"
              value={filters.sort}
              options={SORTS}
              onChange={(sort) => changeFilters({ sort })}
            />
          </div>
        }
      />
      {fixedGenre === undefined ? (
        <GenreChips
          kind={kind}
          genre={filters.genre}
          onChange={(genre) => changeFilters({ genre })}
        />
      ) : null}
      <GridResults
        heading={heading}
        titles={titles}
        emptyTitle={
          isNarrowed(filters) ? `No ${noun[1] ?? ""} match` : `No ${heading.toLowerCase()} yet`
        }
        now={now}
        sentinel={end.ref}
      />
    </div>
  );
}

function GridResults({
  heading,
  titles,
  emptyTitle,
  now,
  sentinel,
}: {
  readonly heading: string;
  readonly titles: Paged<TitleCard>;
  readonly emptyTitle: string;
  readonly now: number;
  readonly sentinel: (element: HTMLElement | null) => (() => void) | undefined;
}) {
  const failure =
    titles.status === "failed"
      ? titles
      : titles.status === "ready" && titles.next.kind === "failed"
        ? titles.next
        : null;

  if (failure !== null) {
    return (
      <CalmState
        className="py-24"
        title={`${heading} didn't load`}
        description={failure.message}
        actions={<Button onClick={failure.retry}>Try again</Button>}
      />
    );
  }

  if (titles.status !== "ready") return <PosterGridSkeleton />;

  const complete = titles.next.kind === "done";

  if (titles.rows.length === 0 && complete) {
    return <CalmState className="py-24" title={emptyTitle} />;
  }

  return (
    <>
      <PosterGrid>
        {titles.rows.map((title) => (
          <TitlePosterCard
            key={title.id}
            title={title}
            subtitle={titleFacts(title) || undefined}
            badge={newBadge(title, now)}
            className="w-full"
          />
        ))}
      </PosterGrid>
      {complete ? null : (
        <div ref={sentinel} aria-hidden className="pt-8">
          <PosterGridSkeleton count={7} />
        </div>
      )}
    </>
  );
}

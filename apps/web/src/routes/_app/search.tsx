import type { ProfileId } from "@media/contracts/ids";
import type { TitleCard, TitleKind } from "@media/contracts/models/catalog";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Chip } from "@media/ui/components/chip";
import { LandscapeCard } from "@media/ui/components/media-card";
import { cn } from "@media/ui/lib/utils";
import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowRightIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react";
import { Schema } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { usePrefetchTitle } from "@/components/browse/prefetch";
import { artworkUrl } from "@/lib/artwork";
import { toastFailure } from "@/lib/failure";
import { formatCount, plural, titleKindFacts } from "@/lib/format";
import { longestWord, similarity } from "@/lib/similarity";
import { useTitleSearch } from "@/lib/use-title-search";
import { useActiveProfile } from "@/session/guards";
import { useScopes } from "@/session/viewer";

const SearchParams = Schema.Struct({ q: Schema.optionalKey(Schema.String) });

export const Route = createFileRoute("/_app/search")({
  validateSearch: Schema.toStandardSchemaV1(SearchParams),
  staticData: { phoneTitle: false },
  head: () => ({ meta: [{ title: "Search · [movies]" }] }),
  component: SearchPage,
});

const SUGGESTION_THRESHOLD = 0.3;

type KindFilter = "all" | TitleKind;

const KIND_CHIPS: ReadonlyArray<{ readonly kind: KindFilter; readonly label: string }> = [
  { kind: "all", label: "All" },
  { kind: "movie", label: "Movies" },
  { kind: "show", label: "Shows" },
];

const resultCount = (empty: boolean, loading: boolean, count: number): string => {
  if (empty) return "No results";

  return loading ? "" : plural(count, "result", "results");
};

function SearchPage() {
  const { q } = Route.useSearch();
  const { profile } = useActiveProfile();
  const navigate = useNavigate();
  const router = useRouter();
  const [text, setText] = useState(q ?? "");
  const [kind, setKind] = useState<KindFilter>("all");
  const input = useRef<HTMLInputElement>(null);
  const search = useTitleSearch(profile.id, text);

  useEffect(() => {
    if (search.query === (q ?? "")) return;

    void navigate({
      to: "/search",
      search: search.query === "" ? {} : { q: search.query },
      replace: true,
    });
  }, [search.query, q, navigate]);

  const counts = useMemo(
    () => ({
      all: search.results.length,
      movie: search.results.filter((title) => title.kind === "movie").length,
      show: search.results.filter((title) => title.kind === "show").length,
    }),
    [search.results],
  );

  const shown =
    kind === "all" ? search.results : search.results.filter((title) => title.kind === kind);

  const settled = search.query !== "" && !search.loading;
  const empty = settled && search.results.length === 0;

  return (
    <div className="mx-auto box-content flex max-w-content flex-col gap-4 px-4 pt-[max(env(safe-area-inset-top),var(--spacing-4))] md:gap-7 md:px-16 md:pt-7">
      <h1 className="px-1 pt-1.5 text-large-title/10 font-heavy tracking-display text-text md:sr-only">
        Search
      </h1>
      <div className="flex items-center gap-3">
        <label className="flex h-11 min-w-0 grow items-center gap-2 rounded-search bg-surface-raised px-3 md:h-18 md:gap-4 md:rounded-control md:border md:border-hairline md:pr-5 md:pl-5.5">
          <SearchIcon
            className="size-4.5 shrink-0 text-text-muted md:size-6"
            strokeWidth={1.75}
            aria-hidden
          />
          <span className="sr-only">Search titles</span>
          <input
            ref={input}
            type="search"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={text}
            placeholder="Movies and shows"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setText("");
            }}
            className="h-full min-w-0 grow bg-transparent text-lead/body text-text caret-accent outline-none placeholder:text-text-muted md:text-search/8.5 md:font-semibold md:tracking-tight [&::-webkit-search-cancel-button]:hidden"
          />
          {search.query === "" ? null : (
            <span className="shrink-0 text-label/label text-text-muted max-md:hidden">
              {resultCount(empty, search.loading, search.results.length)}
            </span>
          )}
          {text === "" ? null : (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setText("");
                input.current?.focus();
              }}
              className="flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-pill bg-text-muted text-bg md:size-8 md:bg-hairline md:text-text"
            >
              <XIcon className="size-2.5 md:size-3.5" strokeWidth={3} aria-hidden />
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={() => router.history.back()}
          className="shrink-0 cursor-pointer text-lead/body text-text md:hidden"
        >
          Cancel
        </button>
      </div>
      {search.query === "" || empty ? null : (
        <KindChips kind={kind} counts={counts} onChange={setKind} />
      )}
      {empty ? (
        <NoResults profileId={profile.id} query={search.query} onSearch={setText} />
      ) : (
        <section aria-label="Results" className="flex flex-col gap-3 pb-8">
          {search.query === "" || shown.length === 0 ? null : (
            <h2 className="text-heading/heading font-bold tracking-tight text-text md:sr-only">
              Top results
            </h2>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-4.5 md:grid-cols-4 md:gap-x-6 md:gap-y-7">
            {shown.map((title) => (
              <ResultCard key={title.id} title={title} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function KindChips({
  kind,
  counts,
  onChange,
}: {
  readonly kind: KindFilter;
  readonly counts: Readonly<Record<KindFilter, number>>;
  readonly onChange: (kind: KindFilter) => void;
}) {
  return (
    <div className="flex gap-2">
      {KIND_CHIPS.map((chip) => (
        <Chip
          key={chip.kind}
          selected={kind === chip.kind}
          onClick={() => onChange(chip.kind)}
          className="max-md:text-small/4.5"
        >
          {chip.label}
          <span className="max-md:hidden">&nbsp;{formatCount(counts[chip.kind])}</span>
        </Chip>
      ))}
    </div>
  );
}

function ResultCard({ title }: { readonly title: TitleCard }) {
  const prefetch = usePrefetchTitle(title.id);

  return (
    <LandscapeCard
      title={title.name}
      subtitle={titleKindFacts(title)}
      image={artworkUrl(title.artwork.backdrop ?? title.artwork.poster, "card")}
      className="w-full gap-1.5 md:gap-2 md:[&>span:nth-child(2)]:text-body/5 md:[&>span:nth-child(3)]:text-label/label"
      render={<Link to="/title/$titleId" params={{ titleId: title.id }} {...prefetch} />}
    />
  );
}

function NoResults({
  profileId,
  query,
  onSearch,
}: {
  readonly profileId: ProfileId;
  readonly query: string;
  readonly onSearch: (text: string) => void;
}) {
  const scopes = useScopes();
  const word = longestWord(query);
  const probe = word.slice(0, 3);

  const candidates = useCommandQuery(
    "titles.search",
    probe.length < 2 ? "skip" : { profileId, query: probe, limit: 20 },
  );

  const libraries = useCommandQuery("libraries.list", scopes.has("manage") ? {} : "skip");
  const scan = useCommand("libraries.scan");

  const suggestion = useMemo(() => {
    if (candidates.status !== "success") return undefined;

    const ranked = candidates.data
      .map((title) => ({ title, score: similarity(query, title.name) }))
      .toSorted((a, b) => b.score - a.score)[0];

    return ranked !== undefined && ranked.score >= SUGGESTION_THRESHOLD ? ranked.title : undefined;
  }, [candidates, query]);

  const words = query
    .split(/\s+/u)
    .filter((part) => part.length > 1 && part.toLowerCase() !== query.toLowerCase());

  const rescan = async (): Promise<void> => {
    if (libraries.status !== "success") return;

    try {
      await Promise.all(libraries.data.map((library) => scan({ libraryId: library.id })));
      toast.success("Scanning your libraries");
    } catch (cause) {
      toastFailure(cause);
    }
  };

  const still =
    suggestion === undefined ? undefined : artworkUrl(suggestion.artwork.backdrop, "card");

  return (
    <div className="flex flex-col items-start gap-12 pt-6 pb-10 md:pt-16">
      <div className="flex flex-col gap-3">
        <h2 className="text-title/title font-heavy tracking-display text-text">
          No results for “{query}”
        </h2>
        <p className="text-lead/heading text-text-muted">Check the spelling or try fewer words.</p>
      </div>
      {suggestion === undefined ? null : (
        <div className="flex flex-col gap-3.5">
          <p className="text-body/body text-text-muted">Did you mean</p>
          <Link
            to="/title/$titleId"
            params={{ titleId: suggestion.id }}
            className="group flex items-center gap-4 rounded-poster"
          >
            <span
              aria-hidden
              className="h-13.5 w-24 shrink-0 rounded-poster bg-surface-raised bg-cover bg-center"
              style={still === undefined ? undefined : { backgroundImage: `url("${still}")` }}
            />
            <span className="text-heading/heading font-bold text-text">{suggestion.name}</span>
            <ArrowRightIcon
              className="size-5 text-text-muted transition-transform group-hover:translate-x-0.5"
              strokeWidth={1.75}
              aria-hidden
            />
          </Link>
        </div>
      )}
      {words.length < 2 ? null : (
        <div className="flex flex-col gap-4">
          <p className="text-body/body text-text-muted">Or search for</p>
          <ul className="flex flex-col gap-3.5">
            {words.map((part) => (
              <li key={part}>
                <button
                  type="button"
                  onClick={() => onSearch(part)}
                  className="flex cursor-pointer items-center gap-3 text-lead/6 font-medium text-text"
                >
                  <SearchIcon className="size-4.5 text-text-muted" strokeWidth={1.75} aria-hidden />
                  {part}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {libraries.status === "success" && libraries.data.length > 0 ? (
        <div className="flex flex-wrap items-center gap-4">
          <p className="text-body/body text-text-muted">Just added it to your library?</p>
          <button
            type="button"
            onClick={() => void rescan()}
            className={cn(
              "flex h-9 cursor-pointer items-center gap-2 rounded-control bg-surface-raised px-3.5 text-label/label font-semibold text-text hover:bg-text/10",
            )}
          >
            <RefreshCwIcon className="size-4" strokeWidth={1.75} aria-hidden />
            Rescan library
          </button>
        </div>
      ) : null}
    </div>
  );
}

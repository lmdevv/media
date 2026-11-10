import { TitleId as MediaTitleId } from "@media/contracts/ids";
import type { MetadataCandidate } from "@media/contracts/models/catalog";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { Input } from "@media/ui/components/input";
import { Eyebrow, PageHeader, crumbLinkClass } from "@media/ui/components/page-header";
import { RadioGroup, RadioItem } from "@media/ui/components/radio-group";
import { Skeleton } from "@media/ui/components/skeleton";
import { Spinner } from "@media/ui/components/spinner";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { describeFailure, isFailure } from "@media/ui/lib/failure";
import { cn } from "@media/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import { Predicate, Schema } from "effect";
import { CheckIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import { artworkUrl } from "@/lib/artwork";

import { useAction } from "./action";
import { editFor, overridesFor, parseYear, planFor } from "./match-plan";
import type { HandEdit } from "./match-plan";
import { formatRuntime, qualityLabel, titleWithYear } from "./media-quality";
import { useMediaServer } from "@/session/error-reporting";
import { Poster } from "./poster";
import type { LibraryId, TitleId } from "./route-params";
import type { TitleDetail } from "./types";

const SEARCH_DELAY_MS = 400;

const decodeMediaTitleId = Schema.decodeUnknownSync(MediaTitleId);

type SearchResults =
  | { readonly status: "idle" }
  | { readonly status: "searching" }
  | { readonly status: "done"; readonly candidates: ReadonlyArray<MetadataCandidate> }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "unavailable" };

const searchFailure = (cause: unknown): SearchResults => {
  if (isFailure(cause, "RateLimited")) {
    return { status: "failed", message: "TMDB is busy. Try again in a moment." };
  }

  if (isFailure(cause, "Internal") || Predicate.isTagged(cause, "TransportError")) {
    return { status: "unavailable" };
  }

  return { status: "failed", message: describeFailure(cause) };
};

const OVERVIEW_PREVIEW = 90;

/** Fix metadata match: the current match beside TMDB search results, and edits by hand. */
export function FixMatchScreen({
  libraryId,
  titleId,
}: {
  readonly libraryId: LibraryId;
  readonly titleId: TitleId;
}) {
  const platform = usePlatform();
  const library = usePlatformQuery(platform.core.libraries.get, { libraryId });
  const title = usePlatformQuery(platform.movies.titles.get, { titleId });
  const libraryName = library.status === "success" ? library.data.name : "Library";

  if (title.status === "loading") return <Skeleton className="h-96 w-full rounded-control" />;

  if (title.status === "error") {
    const gone = isFailure(title.error, "NotFound") || isFailure(title.error, "InvalidArgs");

    return (
      <CalmState
        className="py-24"
        title={gone ? "This title is gone" : "This title didn't load"}
        description={gone ? undefined : describeFailure(title.error)}
        actions={
          <>
            {gone ? null : (
              <Button variant="raised" size="sm" onClick={title.retry}>
                Try again
              </Button>
            )}
            <Link
              to="/admin/libraries/$libraryId"
              params={{ libraryId }}
              className={buttonVariants({ variant: "raised", size: "sm" })}
            >
              Back to {libraryName}
            </Link>
          </>
        }
      />
    );
  }

  return (
    <MatchEditor
      key={title.data.id}
      libraryId={libraryId}
      libraryName={libraryName}
      title={title.data}
    />
  );
}

/** The title's kind, best version's quality, and how many versions are on disk. */
const factsOf = (title: TitleDetail): string => {
  const [best] = title.versions;
  const kind = title.kind === "show" ? "Series" : "Film";

  if (best === undefined) return kind;

  const versions = title.versions.length === 1 ? null : `${title.versions.length} versions`;

  return [kind, qualityLabel(best), versions].filter((part) => part !== null).join(" · ");
};

function MatchEditor({
  libraryId,
  libraryName,
  title,
}: {
  readonly libraryId: LibraryId;
  readonly libraryName: string;
  readonly title: TitleDetail;
}) {
  const platform = usePlatform();
  const media = useMediaServer();
  const navigate = useNavigate();
  const current = editFor({ name: title.name, year: title.year, tmdbId: title.externalIds.tmdb });
  const [query, setQuery] = useState(title.name);
  const [yearFilter, setYearFilter] = useState(title.year === null ? "" : String(title.year));
  const [chosen, setChosen] = useState<string | null>(title.externalIds.tmdb);
  const [hand, setHand] = useState<HandEdit>(current);

  const [results, setResults] = useState<SearchResults>({ status: "idle" });

  useEffect(() => {
    const text = query.trim();

    if (text === "") {
      setResults({ status: "idle" });

      return () => undefined;
    }

    let live = true;
    const year = parseYear(yearFilter);
    const mediaTitleId = decodeMediaTitleId(title.id);

    const lookUp = async (): Promise<void> => {
      setResults({ status: "searching" });

      try {
        const candidates = await media.run(
          "metadata.searchCandidates",
          year === null
            ? { titleId: mediaTitleId, query: text }
            : { titleId: mediaTitleId, query: text, year },
        );

        if (live) setResults({ status: "done", candidates });
      } catch (cause) {
        if (live) setResults(searchFailure(cause));
      }
    };

    const timer = window.setTimeout(() => void lookUp(), SEARCH_DELAY_MS);

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, yearFilter, title.id, media]);

  const candidates = results.status === "done" ? results.candidates : [];

  const choose = (providerId: string): void => {
    setChosen(providerId);

    const candidate = candidates.find((each) => each.providerId === providerId);

    if (candidate !== undefined) {
      setHand(
        editFor({ name: candidate.name, year: candidate.year, tmdbId: candidate.providerId }),
      );
    }
  };

  const { tmdbId, rematch, name, year, rename, redate, yearInvalid } = planFor({
    currentTmdbId: title.externalIds.tmdb,
    current,
    hand,
    candidates,
  });

  const back = { to: "/admin/libraries/$libraryId", params: { libraryId } } as const;

  const apply = useAction(
    async () => {
      if (rematch) {
        await platform.movies.metadata.match({
          titleId: title.id,
          provider: "tmdb",
          providerId: tmdbId,
        });
      }

      if (rename || redate) {
        await platform.movies.metadata.edit({
          titleId: title.id,
          set: overridesFor(rename ? name : null, redate ? year : null),
        });
      }

      return name === "" ? title.name : name;
    },
    {
      success: (applied) => (rematch ? `Matching ${applied}…` : `Saved ${applied}`),
      onSuccess: () => void navigate(back),
    },
  );

  const refresh = useAction(() => platform.movies.metadata.refresh({ titleId: title.id }), {
    success: () => `Refreshing ${title.name}…`,
  });

  return (
    <>
      <PageHeader
        crumbs={[
          <Link key="libraries" to="/admin/libraries" className={crumbLinkClass}>
            Libraries
          </Link>,
          <Link key="library" {...back} className={crumbLinkClass}>
            {libraryName}
          </Link>,
        ]}
        title="Fix match"
        facts={factsOf(title)}
        actions={
          <>
            <Link {...back} className={buttonVariants({ variant: "raised", size: "xs" })}>
              Cancel
            </Link>
            {title.externalIds.tmdb === null ? null : (
              <Button
                variant="raised"
                size="xs"
                disabled={refresh.pending}
                onClick={() => void refresh.run()}
              >
                <RefreshCwIcon strokeWidth={1.75} aria-hidden />
                Refresh
              </Button>
            )}
            <Button
              size="xs"
              className="font-semibold"
              disabled={apply.pending || yearInvalid || !(rematch || rename || redate)}
              onClick={() => void apply.run()}
            >
              <CheckIcon strokeWidth={2} aria-hidden />
              Apply match
            </Button>
          </>
        }
      />
      <div className="flex flex-col items-start gap-10 md:flex-row">
        <CurrentMatch title={title} />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Eyebrow>Search TMDB</Eyebrow>
            <div className="flex gap-2">
              <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control border border-text-muted bg-surface-raised px-3">
                <SearchIcon
                  className="size-3.5 shrink-0 text-text-muted"
                  strokeWidth={1.75}
                  aria-hidden
                />
                <input
                  type="search"
                  aria-label="Search TMDB"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent font-sans text-body/body text-text outline-none"
                />
              </label>
              <Input
                aria-label="Year"
                inputMode="numeric"
                value={yearFilter}
                onChange={(event) => setYearFilter(event.target.value)}
                placeholder="Year"
                className="h-9 w-24 shrink-0 font-mono text-label/label"
              />
            </div>
          </div>
          <Candidates
            results={results}
            chosen={chosen}
            currentId={title.externalIds.tmdb}
            onChoose={choose}
          />
          <HandEditFields hand={hand} onChange={setHand} yearInvalid={yearInvalid} />
        </div>
      </div>
    </>
  );
}

function CurrentMatch({ title }: { readonly title: TitleDetail }) {
  const [best] = title.versions;

  return (
    <section aria-label="Matched to now" className="flex w-65 shrink-0 flex-col gap-3.5">
      <Eyebrow>Matched to now</Eyebrow>
      <Poster
        src={artworkUrl(title.artwork.poster, "poster")}
        alt={title.name}
        className="h-60 w-40 rounded-poster"
      />
      <div className="flex flex-col gap-1">
        <span className="font-sans text-body/body font-semibold text-text">
          {title.matchStatus === "unmatched" ? "No match" : titleWithYear(title)}
        </span>
      </div>
      {best === undefined ? null : (
        <span className="font-mono text-caption/caption text-text-muted">
          File runs {formatRuntime(best.durationMs)} · {qualityLabel(best)}
        </span>
      )}
    </section>
  );
}

function Candidates({
  results,
  chosen,
  currentId,
  onChoose,
}: {
  readonly results: SearchResults;
  readonly chosen: string | null;
  readonly currentId: string | null;
  readonly onChoose: (providerId: string) => void;
}): ReactNode {
  if (results.status === "idle") return null;

  if (results.status === "searching") {
    return (
      <div className="flex h-17 items-center gap-3 px-3.5 font-sans text-label/label text-text-muted">
        <Spinner className="text-text" />
        Searching TMDB…
      </div>
    );
  }

  if (results.status === "unavailable") {
    return (
      <div role="status" className="flex flex-col gap-1 px-3.5 py-4">
        <p className="font-sans text-body/body font-semibold text-text">
          TMDB search isn’t available on this server
        </p>
        <p className="font-sans text-label/label text-text-muted">
          Edit the title, year, or TMDB ID by hand below.
        </p>
      </div>
    );
  }

  if (results.status === "failed") {
    return <p className="px-3.5 py-4 font-sans text-label/label text-danger">{results.message}</p>;
  }

  if (results.candidates.length === 0) {
    return (
      <p className="px-3.5 py-4 font-sans text-label/label text-text-muted">No matches on TMDB.</p>
    );
  }

  return (
    <RadioGroup
      aria-label="Matches"
      value={chosen}
      onValueChange={(value) => {
        if (Predicate.isString(value)) onChoose(value);
      }}
      className="gap-1"
    >
      {results.candidates.map((candidate) => (
        <CandidateRow
          key={candidate.providerId}
          candidate={candidate}
          selected={candidate.providerId === chosen}
          current={candidate.providerId === currentId}
        />
      ))}
    </RadioGroup>
  );
}

const candidateLine = (candidate: MetadataCandidate, current: boolean): string => {
  const overview =
    candidate.overview === null
      ? null
      : candidate.overview.length > OVERVIEW_PREVIEW
        ? `${candidate.overview.slice(0, OVERVIEW_PREVIEW).trimEnd()}…`
        : candidate.overview;

  return [current ? "Current match" : null, candidate.kind === "show" ? "Series" : "Film", overview]
    .filter((part) => part !== null)
    .join(" · ");
};

function CandidateRow({
  candidate,
  selected,
  current,
}: {
  readonly candidate: MetadataCandidate;
  readonly selected: boolean;
  readonly current: boolean;
}) {
  const id = useId();

  return (
    <label
      htmlFor={id}
      className={cn(
        "flex h-17 shrink-0 cursor-pointer items-center gap-3.5 rounded-control border px-3.5 transition-colors",
        selected
          ? "border-accent bg-surface-raised"
          : "border-transparent hover:bg-surface-raised/55",
      )}
    >
      <RadioItem id={id} value={candidate.providerId} />
      <Poster
        src={candidate.posterUrl}
        alt={candidate.name}
        className="h-12.5 w-8.5 rounded-poster"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-sans text-body/body font-semibold text-text">
          {titleWithYear(candidate)}
        </span>
        <span className="truncate font-sans text-label/label text-text-muted">
          {candidateLine(candidate, current)}
        </span>
      </span>
      <span className="w-20 shrink-0 text-right font-mono text-caption/caption text-text-muted">
        {candidate.providerId}
      </span>
    </label>
  );
}

function HandEditFields({
  hand,
  onChange,
  yearInvalid,
}: {
  readonly hand: HandEdit;
  readonly onChange: (hand: HandEdit) => void;
  readonly yearInvalid: boolean;
}) {
  const titleId = useId();
  const yearId = useId();
  const tmdbId = useId();

  return (
    <div className="flex flex-col gap-3 pt-6">
      <Eyebrow>Or edit by hand</Eyebrow>
      <div className="flex gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label
            htmlFor={titleId}
            className="font-sans text-label/label font-medium text-text-muted"
          >
            Title
          </label>
          <Input
            id={titleId}
            value={hand.name}
            onChange={(event) => onChange({ ...hand, name: event.target.value })}
            className="h-9 px-3"
          />
        </div>
        <div className="flex w-24 shrink-0 flex-col gap-1.5">
          <label
            htmlFor={yearId}
            className="font-sans text-label/label font-medium text-text-muted"
          >
            Year
          </label>
          <Input
            id={yearId}
            inputMode="numeric"
            value={hand.year}
            aria-invalid={yearInvalid || undefined}
            onChange={(event) => onChange({ ...hand, year: event.target.value })}
            className="h-9 px-3 font-mono text-label/label"
          />
        </div>
        <div className="flex w-35 shrink-0 flex-col gap-1.5">
          <label
            htmlFor={tmdbId}
            className="font-sans text-label/label font-medium text-text-muted"
          >
            TMDB ID
          </label>
          <Input
            id={tmdbId}
            inputMode="numeric"
            value={hand.tmdbId}
            onChange={(event) => onChange({ ...hand, tmdbId: event.target.value })}
            className="h-9 px-3 font-mono text-label/label"
          />
        </div>
      </div>
    </div>
  );
}

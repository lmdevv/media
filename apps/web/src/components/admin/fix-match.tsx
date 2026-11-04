import type { LibraryId, TitleId } from "@media/contracts/ids";
import type {
  LibraryFile,
  MetadataCandidate,
  MetadataOverrides,
} from "@media/contracts/models/catalog";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { CalmState } from "@media/ui/components/calm-state";
import { Input } from "@media/ui/components/input";
import { RadioGroup, RadioItem } from "@media/ui/components/radio-group";
import { Skeleton } from "@media/ui/components/skeleton";
import { Spinner } from "@media/ui/components/spinner";
import { cn } from "@media/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import { Predicate } from "effect";
import { CheckIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import { artworkUrl } from "@/lib/artwork";
import { describeFailure, isFailure } from "@/lib/failure";

import { useAction } from "./action";
import { Eyebrow } from "./settings-frame";
import { formatRuntime, qualityLabel, titleWithYear } from "./media-quality";
import { PageHeader, crumbLinkClass } from "./page-header";
import { Poster } from "./poster";

const SEARCH_DELAY_MS = 400;

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
  const library = useCommandQuery("libraries.get", { libraryId });
  const files = useCommandQuery("libraries.files", { libraryId, titleId, limit: 10 });
  const file = files.status === "success" ? files.data.items[0] : undefined;
  const libraryName = library.status === "success" ? library.data.name : "Library";

  if (files.status === "loading") return <Skeleton className="h-96 w-full rounded-control" />;

  if (file === undefined) {
    return (
      <CalmState
        className="py-24"
        title="This title is gone"
        description={files.status === "error" ? files.error.message : undefined}
        actions={
          <Link
            to="/admin/libraries/$libraryId"
            params={{ libraryId }}
            className={buttonVariants({ variant: "raised", size: "sm" })}
          >
            Back to {libraryName}
          </Link>
        }
      />
    );
  }

  return (
    <MatchEditor key={file.title.id} libraryId={libraryId} libraryName={libraryName} file={file} />
  );
}

interface HandEdit {
  readonly name: string;
  readonly year: string;
  readonly tmdbId: string;
}

const editFor = (source: {
  readonly name: string;
  readonly year: number | null;
  readonly tmdbId: string | null;
}): HandEdit => ({
  name: source.name,
  year: source.year === null ? "" : String(source.year),
  tmdbId: source.tmdbId ?? "",
});

const overridesFor = (name: string | null, year: number | null): MetadataOverrides => {
  if (name !== null && year !== null) return { name, year };

  if (name !== null) return { name };

  return year === null ? {} : { year };
};

const parseYear = (text: string): number | null => {
  const year = Number(text.trim());

  return text.trim() !== "" && Number.isInteger(year) && year >= 1870 && year <= 2200 ? year : null;
};

interface MatchPlan {
  readonly tmdbId: string;
  readonly rematch: boolean;
  readonly name: string;
  readonly year: number | null;
  readonly rename: boolean;
  readonly redate: boolean;
  readonly yearInvalid: boolean;
}

const planFor = ({
  currentTmdbId,
  current,
  hand,
  candidates,
}: {
  readonly currentTmdbId: string | null;
  readonly current: HandEdit;
  readonly hand: HandEdit;
  readonly candidates: ReadonlyArray<MetadataCandidate>;
}): MatchPlan => {
  const tmdbId = hand.tmdbId.trim();
  const rematch = tmdbId !== "" && tmdbId !== (currentTmdbId ?? "");
  const base = candidates.find((each) => each.providerId === tmdbId);

  const expected = rematch
    ? editFor({ name: base?.name ?? hand.name, year: base?.year ?? null, tmdbId })
    : current;

  const name = hand.name.trim();
  const year = parseYear(hand.year);

  return {
    tmdbId,
    rematch,
    name,
    year,
    rename: name !== "" && name !== expected.name,
    redate: year !== null && hand.year.trim() !== expected.year,
    yearInvalid: hand.year.trim() !== "" && year === null,
  };
};

function MatchEditor({
  libraryId,
  libraryName,
  file,
}: {
  readonly libraryId: LibraryId;
  readonly libraryName: string;
  readonly file: LibraryFile;
}) {
  const navigate = useNavigate();
  const search = useCommand("metadata.searchCandidates");
  const fixMatch = useCommand("metadata.fixMatch");
  const edit = useCommand("metadata.edit");
  const { title } = file;
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

    const lookUp = async (): Promise<void> => {
      setResults({ status: "searching" });

      try {
        const candidates = await search(
          year === null
            ? { titleId: title.id, query: text }
            : { titleId: title.id, query: text, year },
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
  }, [query, yearFilter, title.id, search]);

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
      if (rematch) await fixMatch({ titleId: title.id, provider: "tmdb", providerId: tmdbId });

      if (rename || redate) {
        await edit({
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
        facts={file.path}
        actions={
          <>
            <Link {...back} className={buttonVariants({ variant: "raised", size: "xs" })}>
              Cancel
            </Link>
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
        <CurrentMatch file={file} />
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

function CurrentMatch({ file }: { readonly file: LibraryFile }) {
  const { title } = file;

  return (
    <section aria-label="Matched to now" className="flex w-65 shrink-0 flex-col gap-3.5">
      <Eyebrow>Matched to now</Eyebrow>
      <Poster
        src={artworkUrl(title.poster, "poster")}
        alt={title.name}
        className="h-60 w-40 rounded-poster"
      />
      <div className="flex flex-col gap-1">
        <span className="font-sans text-body/body font-semibold text-text">
          {title.matchStatus === "unmatched" ? "No match" : titleWithYear(title)}
        </span>
      </div>
      <span className="font-mono text-caption/caption text-text-muted">
        File runs {formatRuntime(file.durationMs)} · {qualityLabel(file.video)}
      </span>
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

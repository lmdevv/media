import type {
  CollectionId,
  Credit,
  CreditKind,
  Ratings,
  TitleDetail,
  TitleId,
  Trailer,
} from "@/lib/catalog";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Avatar } from "@media/ui/components/avatar";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { MediaRow } from "@media/ui/components/media-row";
import { cn } from "@media/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, ClapperboardIcon, StarIcon } from "lucide-react";
import { Fragment, useRef, useState } from "react";

import { artworkUrl } from "@/lib/artwork";
import { toastFailure } from "@media/ui/lib/failure";
import type { ExternalLink } from "@/lib/metadata";
import { creditLines, creditRole, scoresOf, trailerEmbedUrl } from "@/lib/metadata";

import { TitleLandscapeCard, TitlePosterCard } from "./title-cards";
import type { TrailerDialog as TrailerDialogComponent } from "./trailer-dialog";

const loadTrailerDialog = () => import("./trailer-dialog");

const CAST_ROW_LIMIT = 24;

/** `IMDb 7.9 · RT 88% · MC 73 · TMDB 7.1`, each score labeled for screen readers. */
export function Scores({
  ratings,
  className,
}: {
  readonly ratings: Ratings;
  readonly className?: string;
}) {
  const scores = scoresOf(ratings);

  if (scores.length === 0) return null;

  return (
    <ul
      aria-label="Ratings"
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)}
    >
      {scores.map((score) => (
        <li
          key={score.site}
          aria-label={`${score.label} ${score.value}`}
          className="flex items-center gap-1.5 text-body/body text-text"
        >
          {score.site === "imdb" ? (
            <StarIcon className="size-4 fill-current text-warning" strokeWidth={1.75} aria-hidden />
          ) : null}
          <span
            aria-hidden
            className="text-caption/caption font-semibold tracking-caps text-text-muted"
          >
            {score.mark}
          </span>
          <span aria-hidden className="font-semibold">
            {score.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Links out to IMDb, TMDB, and TVDB, opened in a new tab without a referrer. */
export function ExternalLinks({ links }: { readonly links: ReadonlyArray<ExternalLink> }) {
  if (links.length === 0) return null;

  return (
    <ul className="flex flex-wrap items-center gap-3">
      {links.map((link) => (
        <li key={link.label}>
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-label/label font-semibold text-text-muted transition-colors hover:text-text"
          >
            {link.label}
            <ArrowUpRightIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Names that link to people's pages, joined with commas. */
export function PeopleLinks({ people }: { readonly people: ReadonlyArray<Credit> }) {
  return (
    <>
      {people.map((person, index) => (
        <Fragment key={person.personId}>
          {index === 0 ? null : ", "}
          <Link
            to="/person/$personId"
            params={{ personId: person.personId }}
            className="underline-offset-4 hover:underline"
          >
            {person.name}
          </Link>
        </Fragment>
      ))}
    </>
  );
}

/** `Directed by …` lines for the kinds given, such as the creators and directors under a title. */
export function CreditSummary({
  credits,
  kinds,
  className,
}: {
  readonly credits: ReadonlyArray<Credit>;
  readonly kinds: ReadonlyArray<CreditKind>;
  readonly className?: string;
}) {
  const lines = creditLines(credits, kinds);

  if (lines.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-1 text-body/body text-text", className)}>
      {lines.map((line) => (
        <p key={line.heading}>
          <span className="text-text-muted">{line.heading} </span>
          <PeopleLinks people={line.people} />
        </p>
      ))}
    </div>
  );
}

function PersonCard({
  personId,
  name,
  role,
  profile,
}: {
  readonly personId: Credit["personId"];
  readonly name: string;
  readonly role: string | null;
  readonly profile: string | null;
}) {
  return (
    <Link
      to="/person/$personId"
      params={{ personId }}
      className="group/person flex w-24 shrink-0 snap-start flex-col items-center gap-2 rounded-control text-center"
    >
      <Avatar
        name={name}
        image={artworkUrl(profile, "thumb")}
        size="md"
        round
        centered
        decorative
        className="transition-opacity group-hover/person:opacity-85"
      />
      <span className="flex flex-col gap-0.5">
        <span className="line-clamp-2 text-label/4 font-semibold text-text">{name}</span>
        {role === null ? null : (
          <span className="line-clamp-2 text-caption/4 text-text-muted">{role}</span>
        )}
      </span>
    </Link>
  );
}

const roleOf = (credit: Credit): string | null =>
  credit.kind === "actor" || credit.kind === "guest-star"
    ? credit.role
    : creditRole({ kind: credit.kind, role: credit.role, episodeCount: 0 });

/** The cast and crew row: billed actors first, then who made it. */
export function CastAndCrew({ title }: { readonly title: TitleDetail }) {
  const seen = new Set<string>();

  const people = [...title.cast, ...title.crew]
    .filter((credit) => {
      const key = `${credit.personId}:${credit.kind}`;

      if (seen.has(key)) return false;
      seen.add(key);

      return true;
    })
    .slice(0, CAST_ROW_LIMIT);

  if (people.length === 0) return null;

  return (
    <MediaRow title="Cast & crew">
      {people.map((credit) => (
        <PersonCard
          key={`${credit.personId}:${credit.kind}`}
          personId={credit.personId}
          name={credit.name}
          role={roleOf(credit)}
          profile={credit.profile}
        />
      ))}
    </MediaRow>
  );
}

/** The trailer button and the dialog that plays it from YouTube's cookieless player. */
export function TrailerButton({
  trailer,
  name,
  phone,
}: {
  readonly trailer: Trailer;
  readonly name: string;
  readonly phone: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<typeof TrailerDialogComponent | null>(null);
  const [pending, setPending] = useState(false);
  const loading = useRef<Promise<typeof TrailerDialogComponent> | null>(null);
  const src = trailerEmbedUrl(trailer.key);

  if (src === undefined) return null;

  const load = (): Promise<typeof TrailerDialogComponent> => {
    loading.current ??= loadTrailerDialog().then(
      (loaded) => {
        setDialog(() => loaded.TrailerDialog);

        return loaded.TrailerDialog;
      },
      (cause: unknown) => {
        loading.current = null;

        throw cause;
      },
    );

    return loading.current;
  };

  const prepare = (): void => {
    load().catch(() => undefined);
  };

  const show = async (): Promise<void> => {
    if (dialog !== null) {
      setOpen(true);

      return;
    }

    if (pending) return;

    setPending(true);

    try {
      await load();
      // Mount closed first, then open on the next frame, so the first opening animates as well.
      requestAnimationFrame(() => setOpen(true));
    } catch (cause) {
      toastFailure(cause);
    } finally {
      setPending(false);
    }
  };

  const Dialog = dialog;

  return (
    <>
      <button
        type="button"
        aria-busy={pending || undefined}
        onPointerEnter={prepare}
        onFocus={prepare}
        onClick={() => void show()}
        className={
          phone
            ? "flex w-26 cursor-pointer flex-col items-center gap-1.5 text-caption/caption text-text-muted aria-busy:cursor-progress"
            : cn(buttonVariants({ variant: "secondary", size: "lg" }), "aria-busy:cursor-progress")
        }
      >
        <ClapperboardIcon
          className={phone ? "size-5.5 text-text" : undefined}
          strokeWidth={1.75}
          aria-hidden
        />
        Trailer
      </button>
      {Dialog === null ? null : (
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title={trailer.name ?? `${name} trailer`}
          frameTitle={`${name} trailer`}
          src={src}
        />
      )}
    </>
  );
}

/** "Part of the Alien Collection": the other titles of the collection, in order. */
export function CollectionRow({
  collectionId,
  titleId,
  phone,
}: {
  readonly collectionId: CollectionId;
  readonly titleId: TitleId;
  readonly phone: boolean;
}) {
  const platform = usePlatform();
  const collection = usePlatformQuery(platform.movies.collections.get, { collectionId });

  if (collection.status !== "success" || collection.data.titles.length < 2) return null;

  return (
    <MediaRow
      title={`Part of ${collection.data.name}`}
      seeAll={<Link to="/collection/$collectionId" params={{ collectionId }} />}
    >
      {collection.data.titles.map((title) =>
        phone ? (
          <TitleLandscapeCard key={title.id} title={title} size="phone" />
        ) : (
          <TitlePosterCard
            key={title.id}
            title={title}
            badge={title.id === titleId ? "Viewing" : undefined}
          />
        ),
      )}
    </MediaRow>
  );
}

/** More like this: recommendations and look-alikes the person may see. */
export function MoreLikeThis({
  titleId,
  phone,
}: {
  readonly titleId: TitleId;
  readonly phone: boolean;
}) {
  const platform = usePlatform();
  const similar = usePlatformQuery(platform.movies.titles.similar, { titleId });

  if (similar.status !== "success" || similar.data.length === 0) return null;

  return (
    <MediaRow title="More like this">
      {similar.data.map((title) =>
        phone ? (
          <TitleLandscapeCard key={title.id} title={title} size="phone" />
        ) : (
          <TitlePosterCard key={title.id} title={title} />
        ),
      )}
    </MediaRow>
  );
}

import { PersonId } from "@media/contracts/ids";
import type { PersonDetail } from "@media/contracts/models/people";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { monogramOf } from "@media/ui/lib/monogram";
import { CalmState } from "@media/ui/components/calm-state";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { useEffect } from "react";

import { PosterGridSkeleton } from "@/components/browse/skeletons";
import { TitlePosterCard } from "@/components/browse/title-cards";
import { ExternalLinks } from "@/components/browse/title-extras";
import { PosterGrid } from "@/components/browse/title-grid-page";
import { artworkUrl } from "@/lib/artwork";
import { describeFailure, isFailure } from "@/lib/failure";
import { facts } from "@/lib/format";
import { formatDate, personLinks, personRole, yearsBetween } from "@/lib/metadata";
import { useActiveProfile } from "@/session/guards";

const decodePersonId = Schema.decodeSync(PersonId);

export const Route = createFileRoute("/_app/person/$personId")({
  params: {
    parse: (raw) => ({ personId: decodePersonId(raw.personId) }),
    stringify: (params) => ({ personId: params.personId }),
  },
  component: PersonPage,
});

const today = (): string => new Date().toISOString().slice(0, 10);

const lifeLines = (person: PersonDetail): ReadonlyArray<string> => {
  const age =
    person.birthDate === null ? null : yearsBetween(person.birthDate, person.deathDate ?? today());

  const born =
    person.birthDate === null
      ? null
      : [
          `Born ${formatDate(person.birthDate)}`,
          person.birthPlace === null ? "" : ` in ${person.birthPlace}`,
          person.deathDate === null && age !== null ? ` (age ${age})` : "",
        ].join("");

  const died =
    person.deathDate === null
      ? null
      : `Died ${formatDate(person.deathDate)}${age === null ? "" : `, aged ${age}`}`;

  return [born, died].flatMap((line) => (line === null ? [] : [line]));
};

function PersonPage() {
  const { personId } = Route.useParams();
  const { profile } = useActiveProfile();
  const person = useCommandQuery("people.get", { profileId: profile.id, personId });
  const requestDetails = useCommand("people.requestDetails");
  const pending = person.status === "success" && person.data.detailsPending;

  useEffect(() => {
    if (pending) {
      requestDetails({ profileId: profile.id, personId }).catch(() => undefined);
    }
  }, [pending, profile.id, personId, requestDetails]);

  if (person.status === "loading") {
    return (
      <div aria-busy className="mx-auto box-content max-w-content px-4 pt-8 md:px-16 md:pt-26">
        <PosterGridSkeleton count={7} />
      </div>
    );
  }

  if (person.status === "error") {
    const missing = isFailure(person.error, "NotFound");

    return (
      <div className="flex min-h-[70svh] items-center justify-center px-6 md:pt-17">
        <CalmState
          title={missing ? "This person isn't here" : "This person didn't load"}
          description={missing ? undefined : describeFailure(person.error)}
          actions={
            <>
              {missing ? null : <Button onClick={person.retry}>Try again</Button>}
              <Link to="/" className={buttonVariants({ variant: "subtle" })}>
                Go home
              </Link>
            </>
          }
        />
      </div>
    );
  }

  const { data } = person;
  const photo = artworkUrl(data.profile, "poster");

  return (
    <div className="mx-auto box-content flex max-w-content flex-col gap-10 px-4 pt-6 pb-20 md:gap-14 md:px-16 md:pt-26">
      <title>{`${data.name} · [movies]`}</title>
      <section className="flex flex-col gap-6 md:flex-row md:gap-12">
        {photo === undefined ? (
          <div
            aria-hidden
            className="flex aspect-2/3 w-40 shrink-0 items-center justify-center rounded-poster bg-surface-raised font-sans text-display/display font-heavy tracking-display text-text-muted select-none md:w-64"
          >
            {monogramOf(data.name)}
          </div>
        ) : (
          <div
            role="img"
            aria-label={data.name}
            className="aspect-2/3 w-40 shrink-0 rounded-poster bg-surface-raised bg-cover bg-center md:w-64"
            style={{ backgroundImage: `url("${photo}")` }}
          />
        )}
        <div className="flex max-w-170 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-title/title font-heavy tracking-display text-text">{data.name}</h1>
            {data.knownFor === null ? null : (
              <p className="text-body/body text-text-muted">{data.knownFor}</p>
            )}
          </div>
          {lifeLines(data).map((line) => (
            <p key={line} className="text-body/body text-text">
              {line}
            </p>
          ))}
          {data.biography === null ? null : (
            <p className="text-lead/6.75 whitespace-pre-line text-text">{data.biography}</p>
          )}
          <ExternalLinks links={personLinks(data.externalIds)} />
        </div>
      </section>
      <section aria-labelledby="known-for" className="flex flex-col gap-5">
        <h2 id="known-for" className="text-heading/heading font-bold tracking-tight text-text">
          In your library
        </h2>
        <PosterGrid>
          {data.credits.map((credit) => (
            <TitlePosterCard
              key={`${credit.title.id}:${credit.kind}`}
              title={credit.title}
              subtitle={facts(credit.title.year, personRole(credit)) || undefined}
              className="w-full"
            />
          ))}
        </PosterGrid>
      </section>
    </div>
  );
}

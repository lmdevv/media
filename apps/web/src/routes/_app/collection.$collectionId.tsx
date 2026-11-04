import { CollectionId } from "@media/contracts/ids";
import { useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { CalmState } from "@media/ui/components/calm-state";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { HeroSkeleton } from "@/components/browse/skeletons";
import { TitlePosterCard } from "@/components/browse/title-cards";
import { PosterGrid } from "@/components/browse/title-grid-page";
import { artworkUrl } from "@/lib/artwork";
import { describeFailure, isFailure } from "@/lib/failure";
import { plural, titleFacts } from "@/lib/format";
import { useActiveProfile } from "@/session/guards";

const decodeCollectionId = Schema.decodeSync(CollectionId);

export const Route = createFileRoute("/_app/collection/$collectionId")({
  params: {
    parse: (raw) => ({ collectionId: decodeCollectionId(raw.collectionId) }),
    stringify: (params) => ({ collectionId: params.collectionId }),
  },
  staticData: { hero: true },
  component: CollectionPage,
});

function CollectionPage() {
  const { collectionId } = Route.useParams();
  const { profile } = useActiveProfile();
  const collection = useCommandQuery("collections.get", { profileId: profile.id, collectionId });

  if (collection.status === "loading") return <HeroSkeleton />;

  if (collection.status === "error") {
    const missing = isFailure(collection.error, "NotFound");

    return (
      <div className="flex min-h-[70svh] items-center justify-center px-6 md:pt-17">
        <CalmState
          title={missing ? "This collection isn't here" : "This collection didn't load"}
          description={missing ? undefined : describeFailure(collection.error)}
          actions={
            <>
              {missing ? null : <Button onClick={collection.retry}>Try again</Button>}
              <Link to="/collections" className={buttonVariants({ variant: "subtle" })}>
                All collections
              </Link>
            </>
          }
        />
      </div>
    );
  }

  const { data } = collection;

  const backdrop = artworkUrl(
    data.artwork.backdrop ??
      data.titles.find((title) => title.artwork.backdrop !== null)?.artwork.backdrop ??
      null,
    "backdrop",
  );

  return (
    <div className="flex flex-col pb-20">
      <title>{`${data.name} · [movies]`}</title>
      <div
        className="on-media relative isolate flex h-110 flex-col justify-end bg-dark-surface bg-cover bg-center px-4 pb-8 md:px-16"
        style={backdrop === undefined ? undefined : { backgroundImage: `url("${backdrop}")` }}
      >
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-linear-to-b from-dark-bg/55 via-transparent via-20% to-page to-92%"
        />
        <div className="mx-auto flex w-full max-w-content flex-col gap-3">
          <h1 className="text-display/display font-hero tracking-display text-text">{data.name}</h1>
          <p className="text-label/label text-text-muted">
            {plural(data.titles.length, "title", "titles")}
          </p>
          {data.overview === null ? null : (
            <p className="max-w-170 text-lead/6.75 text-text">{data.overview}</p>
          )}
        </div>
      </div>
      <div className="mx-auto box-content w-full max-w-content px-4 pt-6 md:px-16">
        <PosterGrid>
          {data.titles.map((title) => (
            <TitlePosterCard
              key={title.id}
              title={title}
              subtitle={titleFacts(title) || undefined}
              className="w-full"
            />
          ))}
        </PosterGrid>
      </div>
    </div>
  );
}

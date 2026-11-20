import { useMayShareGuests } from "@media/ui/lib/use-guest-links";
import { openingPageArgs } from "@media/contracts/opening-season";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { CalmState } from "@media/ui/components/calm-state";
import { preloadFirstPage } from "@media/ui/lib/pages";
import { Link, createFileRoute } from "@tanstack/react-router";

import { asTitleId } from "@/lib/catalog";
import { Block } from "@/components/browse/skeletons";
import { TitleDetailView } from "@/components/browse/title-detail";
import { describeFailure, isFailure } from "@media/ui/lib/failure";
import { usePhone } from "@/lib/use-phone";
import { useScopes } from "@/session/session";

export const Route = createFileRoute("/_app/title/$titleId")({
  params: {
    parse: (raw) => ({ titleId: asTitleId(raw.titleId) }),
    stringify: (params) => ({ titleId: params.titleId }),
  },
  staticData: { hero: true, phoneTitle: false },
  loader: async ({ context: { platform }, params: { titleId } }) => {
    // The page's other queries start with the title's, so they arrive with it rather than a round
    // trip after it. The episodes page is the one the list opens on; a movie's is empty.
    void platform.movies.titles.versions.preload({ titleId });
    void preloadFirstPage(platform.movies.titles.episodes, (paginationOpts) =>
      openingPageArgs(titleId, paginationOpts),
    );
    void platform.movies.titles.similar.preload({ titleId });
    void platform.movies.collections.ofTitle.preload({ titleId });
    await platform.movies.titles.get.preload({ titleId });
  },
  pendingComponent: TitleSkeleton,
  component: TitlePage,
});

/**
 * The title page while its details load: the backdrop with the name over it, then the facts, the
 * Play button, and the overview below, at the sizes of the phone and desktop layouts.
 */
function TitleSkeleton() {
  return (
    <div aria-busy className="flex flex-col">
      <div className="flex h-75 flex-col justify-end bg-surface-raised px-5 pb-2 md:h-145 md:px-16 md:pb-8">
        <div className="mx-auto flex w-full max-w-content flex-col gap-3.5">
          <Block tone="bar" className="h-11 w-60 rounded-inner md:h-26 md:w-140" />
          <Block tone="bar" className="h-6 w-90 rounded-poster max-md:hidden" />
        </div>
      </div>
      <div className="mx-auto box-content flex w-full max-w-content flex-col gap-3.5 px-4 pt-1 md:gap-5 md:px-16 md:pt-0">
        <Block tone="bar" className="h-4.5 w-48 rounded-bar md:h-6 md:w-72" />
        <Block className="h-12.5 w-full rounded-pill md:h-12 md:w-35 md:rounded-control" />
        <div className="flex flex-col gap-2 md:w-170 md:pt-2">
          <Block tone="bar" className="h-4 w-full rounded-bar" />
          <Block tone="bar" className="h-4 w-full rounded-bar" />
          <Block tone="bar" className="h-4 w-2/3 rounded-bar" />
        </div>
      </div>
    </div>
  );
}

function TitlePage() {
  const platform = usePlatform();
  const { titleId } = Route.useParams();
  const scopes = useScopes();
  const phone = usePhone();
  const mayShareGuests = useMayShareGuests();
  const title = usePlatformQuery(platform.movies.titles.get, { titleId });

  if (title.status === "loading") return <TitleSkeleton />;

  if (title.status === "error") {
    const missing = isFailure(title.error, "NotFound");

    return (
      <div className="flex min-h-[70svh] items-center justify-center px-6 md:pt-17">
        <CalmState
          title={missing ? "This title isn't here" : "This title didn't load"}
          description={missing ? undefined : describeFailure(title.error)}
          actions={
            <>
              {missing ? null : <Button onClick={title.retry}>Try again</Button>}
              <Link to="/" className={buttonVariants({ variant: "subtle" })}>
                Go home
              </Link>
            </>
          }
        />
      </div>
    );
  }

  return (
    <>
      <title>{`${title.data.name} · Lar Movies`}</title>
      <TitleDetailView
        key={titleId}
        title={title.data}
        canManage={scopes.has("movies:edit")}
        phone={phone}
        mayShareGuests={mayShareGuests}
      />
    </>
  );
}

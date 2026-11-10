import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { CalmState } from "@media/ui/components/calm-state";
import { Link, createFileRoute } from "@tanstack/react-router";

import { asTitleId } from "@/lib/catalog";
import { HeroSkeleton } from "@/components/browse/skeletons";
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
  component: TitlePage,
});

function TitlePage() {
  const platform = usePlatform();
  const { titleId } = Route.useParams();
  const scopes = useScopes();
  const phone = usePhone();
  const title = usePlatformQuery(platform.movies.titles.get, { titleId });

  if (title.status === "loading") return <HeroSkeleton />;

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
      <title>{`${title.data.name} · [movies]`}</title>
      <TitleDetailView title={title.data} canManage={scopes.has("movies:edit")} phone={phone} />
    </>
  );
}

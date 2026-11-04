import type { Profile } from "@media/contracts/models/profiles";
import { useCommandQuery } from "@media/sdk/react";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { AddProfileTile, ProfileTile } from "@media/ui/components/profile-tile";
import { cn } from "@media/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PencilIcon } from "lucide-react";
import { Schema } from "effect";
import { useState } from "react";

import { AuthPage } from "@/components/auth/auth-page";
import { profileArt } from "@/components/profiles/profile-art";
import { safeRedirect } from "@/lib/redirect-target";
import { PageFailure, RequireSignedIn } from "@/session/guards";
import { useProfileChoice } from "@/session/profile-choice";
import { BlankPage } from "@/session/redirect";

const ProfilesSearch = Schema.Struct({ redirect: Schema.optionalKey(Schema.String) });

export const Route = createFileRoute("/profiles/")({
  validateSearch: Schema.toStandardSchemaV1(ProfilesSearch),
  head: () => ({ meta: [{ title: "Who's watching? · [movies]" }] }),
  component: () => (
    <RequireSignedIn>
      <WhosWatchingPage />
    </RequireSignedIn>
  ),
});

const MAX_PROFILES = 10;

function WhosWatchingPage() {
  const { redirect } = Route.useSearch();
  const profiles = useCommandQuery("profiles.list", {});
  const { choose } = useProfileChoice();
  const navigate = useNavigate();
  const [managing, setManaging] = useState(false);
  const target = safeRedirect(redirect);

  if (profiles.status === "loading") return <BlankPage />;

  if (profiles.status === "error")
    return <PageFailure cause={profiles.error} retry={profiles.retry} />;

  const open = (profile: Profile): void => {
    if (managing) {
      void navigate({ to: "/profiles/$profileId/edit", params: { profileId: profile.id } });

      return;
    }

    if (profile.locked) {
      void navigate({
        to: "/profiles/$profileId/pin",
        params: { profileId: profile.id },
        search: { redirect: target },
      });

      return;
    }

    choose(profile.id);
    void navigate({ href: target, replace: true });
  };

  return (
    <AuthPage width="page" offset="centered" phoneBrand={false}>
      <div className="flex flex-col gap-5 md:items-center md:gap-14">
        <h1 className="text-large-title/10 font-heavy tracking-snug text-text md:text-display/display md:font-bold md:tracking-display">
          {managing ? "Manage profiles" : "Who's watching?"}
        </h1>
        <ul className="grid grid-cols-2 justify-items-center gap-5 md:flex md:flex-wrap md:items-start md:justify-center md:gap-8">
          {profiles.data.map((profile) => {
            const art = profileArt(profile);

            return (
              <li key={profile.id} className="relative">
                <ProfileTile
                  name={profile.name}
                  image={art.image}
                  monogram={art.monogram}
                  locked={profile.hasPin}
                  aria-label={managing ? `Edit ${profile.name}` : profile.name}
                  onClick={() => open(profile)}
                />
                {managing ? (
                  <span
                    aria-hidden
                    className="on-media pointer-events-none absolute top-17 left-1/2 flex size-10 -translate-x-1/2 items-center justify-center rounded-pill bg-dark-bg/55 backdrop-blur-md md:top-15"
                  >
                    <PencilIcon className="size-4" strokeWidth={1.75} />
                  </span>
                ) : null}
              </li>
            );
          })}
          {profiles.data.length < MAX_PROFILES ? (
            <li>
              <AddProfileTile onClick={() => void navigate({ to: "/profiles/new" })} />
            </li>
          ) : null}
        </ul>
        <button
          type="button"
          onClick={() => setManaging((current) => !current)}
          className={cn(
            buttonVariants({ variant: "ghost" }),
            "fixed inset-x-5 bottom-[max(env(safe-area-inset-bottom),var(--spacing-8))] h-12.5 rounded-card border-0 bg-text/12 text-lead/body md:static md:h-11 md:rounded-control md:border md:border-text-muted md:bg-transparent md:px-5.5 md:text-body/label md:tracking-caps md:text-text-muted",
          )}
        >
          <PencilIcon className="hidden md:block" strokeWidth={1.75} aria-hidden />
          {managing ? "Done" : "Manage profiles"}
        </button>
      </div>
    </AuthPage>
  );
}

import { ProfileId } from "@media/contracts/ids";
import { useCommandQuery } from "@media/sdk/react";
import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { AuthPage } from "@/components/auth/auth-page";
import { ProfileForm } from "@/components/profiles/profile-form";
import { PageFailure, RequireSignedIn } from "@/session/guards";
import { BlankPage, Redirect } from "@/session/redirect";

const decodeProfileId = Schema.decodeSync(ProfileId);

export const Route = createFileRoute("/profiles/$profileId/edit")({
  params: {
    parse: (raw) => ({ profileId: decodeProfileId(raw.profileId) }),
    stringify: (params) => ({ profileId: params.profileId }),
  },
  head: () => ({ meta: [{ title: "Edit profile · [movies]" }] }),
  component: () => (
    <RequireSignedIn>
      <EditProfilePage />
    </RequireSignedIn>
  ),
});

function EditProfilePage() {
  const { profileId } = Route.useParams();
  const profiles = useCommandQuery("profiles.list", {});

  if (profiles.status === "loading") return <BlankPage />;

  if (profiles.status === "error")
    return <PageFailure cause={profiles.error} retry={profiles.retry} />;

  const profile = profiles.data.find((candidate) => candidate.id === profileId);

  if (profile === undefined) return <Redirect href="/profiles" />;

  if (profile.locked) {
    const back = encodeURIComponent(`/profiles/${profile.id}/edit`);

    return <Redirect href={`/profiles/${profile.id}/pin?redirect=${back}`} />;
  }

  return (
    <AuthPage width="dialog" offset="tight">
      <ProfileForm key={profile.id} profile={profile} canDelete={profiles.data.length > 1} />
    </AuthPage>
  );
}

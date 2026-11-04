import { useCommandQuery } from "@media/sdk/react";
import { createFileRoute } from "@tanstack/react-router";

import { AuthPage } from "@/components/auth/auth-page";
import { ProfileForm } from "@/components/profiles/profile-form";
import { RequireSignedIn } from "@/session/guards";
import { BlankPage } from "@/session/redirect";

export const Route = createFileRoute("/profiles/new")({
  head: () => ({ meta: [{ title: "Add profile · [movies]" }] }),
  component: () => (
    <RequireSignedIn>
      <AddProfilePage />
    </RequireSignedIn>
  ),
});

function AddProfilePage() {
  const profiles = useCommandQuery("profiles.list", {});

  if (profiles.status === "loading") return <BlankPage />;

  return (
    <AuthPage width="dialog" offset="tight">
      <ProfileForm
        takenAvatars={profiles.status === "success" ? profiles.data.map((p) => p.avatar) : []}
      />
    </AuthPage>
  );
}

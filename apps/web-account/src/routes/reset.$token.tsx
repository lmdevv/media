import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { createFileRoute } from "@tanstack/react-router";

import { ResetView } from "@/screens/entry/reset";
import { useLinkPage } from "@/screens/entry/use-link-page";
import { useAccountActions } from "@/session/account";

export const Route = createFileRoute("/reset/$token")({
  staticData: { need: "public" },
  head: () => ({ meta: [{ title: "New password · [media]" }] }),
  component: ResetPage,
});

const LINES = { Expired: "This link no longer works. Ask an admin for a new one." };

function ResetPage() {
  const { token } = Route.useParams();
  const platform = usePlatform();
  const { signIn } = useAccountActions();
  const lookup = usePlatformQuery(platform.core.accounts.resetLinks.lookup, { code: token });

  const { state, form } = useLinkPage(lookup, LINES, ({ password }) =>
    signIn({ kind: "reset", code: token, password }),
  );

  return <ResetView state={state} form={form} />;
}

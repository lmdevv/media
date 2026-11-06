import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { createFileRoute } from "@tanstack/react-router";

import { InviteView } from "@/screens/entry/invite";
import { useLinkPage } from "@/screens/entry/use-link-page";
import { useAccountActions } from "@/session/account";

export const Route = createFileRoute("/invite/$code")({
  staticData: { need: "public" },
  head: () => ({ meta: [{ title: "Join · [media]" }] }),
  component: InvitePage,
});

const LINES = { Expired: "This invite no longer works. Ask whoever sent it for a new one." };

function InvitePage() {
  const { code } = Route.useParams();
  const platform = usePlatform();
  const { signIn } = useAccountActions();
  const lookup = usePlatformQuery(platform.core.accounts.invites.lookup, { code });

  const { state, form } = useLinkPage(lookup, LINES, ({ username, password }) =>
    signIn({ kind: "invite", code, username, password }),
  );

  return <InviteView state={state} form={form} />;
}

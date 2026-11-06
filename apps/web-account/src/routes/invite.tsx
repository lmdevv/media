import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { createFileRoute } from "@tanstack/react-router";

import { InviteView } from "@/screens/entry/invite";
import { MissingLink } from "@/screens/entry/link-page";
import { useLinkPage } from "@/screens/entry/use-link-page";
import { useAccountActions } from "@/session/account";
import { linkSecretFor } from "@/session/link-secret";

export const Route = createFileRoute("/invite")({
  staticData: { need: "public" },
  head: () => ({ meta: [{ title: "Join · [media]" }] }),
  component: InvitePage,
});

const LINES = { Expired: "This invite no longer works. Ask whoever sent it for a new one." };

function InvitePage() {
  const code = linkSecretFor(Route.useRouteContext().linkSecret, "/invite");

  return code === "" ? <MissingLink /> : <InviteLink code={code} />;
}

function InviteLink({ code }: { readonly code: string }) {
  const platform = usePlatform();
  const { signIn } = useAccountActions();
  const lookup = usePlatformQuery(platform.core.accounts.invites.lookup, { code });

  const { state, form } = useLinkPage(lookup, LINES, ({ username, password }) =>
    signIn({ kind: "invite", code, username, password }),
  );

  return <InviteView state={state} form={form} />;
}

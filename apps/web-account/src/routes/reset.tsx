import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { createFileRoute } from "@tanstack/react-router";

import { ResetView } from "@/screens/entry/reset";
import { MissingLink } from "@/screens/entry/link-page";
import { useLinkPage } from "@/screens/entry/use-link-page";
import { useAccountActions } from "@/session/account";
import { linkSecretFor } from "@/session/link-secret";

export const Route = createFileRoute("/reset")({
  staticData: { need: "public" },
  head: () => ({ meta: [{ title: "New password · [media]" }] }),
  component: ResetPage,
});

const LINES = { Expired: "This link no longer works. Ask an admin for a new one." };

function ResetPage() {
  const code = linkSecretFor(Route.useRouteContext().linkSecret, "/reset");

  return code === "" ? <MissingLink /> : <ResetLink code={code} />;
}

function ResetLink({ code }: { readonly code: string }) {
  const platform = usePlatform();
  const { signIn } = useAccountActions();
  const lookup = usePlatformQuery(platform.core.accounts.resetLinks.lookup, { code });

  const { state, form } = useLinkPage(lookup, LINES, ({ password }) =>
    signIn({ kind: "reset", code, password }),
  );

  return <ResetView state={state} form={form} />;
}

import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { pageArgs } from "@/components/admin/parts";
import { SettingsFrame } from "@/components/shell";
import { ApiKeysScreen, ApiKeysSkeleton } from "@/screens/people/credentials";

export const Route = createFileRoute("/api-keys")({
  staticData: { need: "account" },
  head: () => ({ meta: [{ title: "API keys · Lar" }] }),
  loader: ({ context: { platform } }) =>
    preloadFirstPage(platform.core.auth.apiKeys.list, pageArgs),
  pendingComponent: () => (
    <SettingsFrame>
      <ApiKeysSkeleton />
    </SettingsFrame>
  ),
  component: () => (
    <SettingsFrame>
      <ApiKeysScreen />
    </SettingsFrame>
  ),
});

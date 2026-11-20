import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { pageArgs } from "@/components/admin/parts";
import { ApiKeysScreen, ApiKeysSkeleton } from "@/screens/people/credentials";

export const Route = createFileRoute("/_you/api-keys")({
  head: () => ({ meta: [{ title: "API keys · Lar" }] }),
  loader: ({ context: { platform } }) =>
    preloadFirstPage(platform.core.auth.apiKeys.list, pageArgs),
  pendingComponent: ApiKeysSkeleton,
  component: ApiKeysScreen,
});

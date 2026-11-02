import { createFileRoute } from "@tanstack/react-router";

import { Redirect } from "@/components/redirect";
import { SettingsNav } from "@/components/settings/settings-nav";
import { useIsDesktop } from "@/lib/use-media";

export const Route = createFileRoute("/_app/settings/")({ component: SettingsIndex });

function SettingsIndex() {
  const desktop = useIsDesktop();

  if (desktop) return <Redirect href="/settings/account" />;

  return <SettingsNav />;
}

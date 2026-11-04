import { cn } from "@music/ui/lib/utils";
import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";

import { PageHeader } from "@/components/library/cards";
import { SettingsNav } from "@/components/settings/settings-nav";

export const Route = createFileRoute("/_app/settings")({ component: SettingsLayout });

function SettingsLayout() {
  const location = useLocation();
  const index = location.pathname.replace(/\/$/, "") === "/settings";

  return (
    <div className="flex flex-col gap-7 px-5 pt-safe-top pb-12 lg:px-12 lg:pt-row">
      <PageHeader title="Settings" />
      <div className="flex gap-12">
        <SettingsNav className="hidden w-50 shrink-0 lg:flex" />
        <div className={cn("flex min-w-0 grow flex-col gap-6", index && "lg:hidden")}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}

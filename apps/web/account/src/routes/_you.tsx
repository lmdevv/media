import { Outlet, createFileRoute } from "@tanstack/react-router";

import { SettingsFrame } from "@/components/shell";

/** The person's own pages, which share one frame, so only the page inside it swaps. */
export const Route = createFileRoute("/_you")({
  staticData: { need: "account" },
  component: () => (
    <SettingsFrame>
      <Outlet />
    </SettingsFrame>
  ),
});

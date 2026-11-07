import { Outlet, createFileRoute } from "@tanstack/react-router";

import { SettingsFrame } from "@/components/shell";

export const Route = createFileRoute("/admin")({
  staticData: { need: "admin" },
  component: () => (
    <SettingsFrame>
      <Outlet />
    </SettingsFrame>
  ),
});

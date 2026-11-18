import { Outlet, createFileRoute } from "@tanstack/react-router";

import { SettingsFrame } from "@/components/admin/settings-frame";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <SettingsFrame>
      <Outlet />
    </SettingsFrame>
  );
}

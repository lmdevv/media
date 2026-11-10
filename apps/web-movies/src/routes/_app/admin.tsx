import { Outlet, createFileRoute } from "@tanstack/react-router";

import { SettingsFrame } from "@/components/admin/settings-frame";

export const Route = createFileRoute("/_app/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <SettingsFrame>
      <Outlet />
    </SettingsFrame>
  );
}

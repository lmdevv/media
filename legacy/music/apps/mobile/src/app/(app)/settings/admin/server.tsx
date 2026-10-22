/** F20 · Server settings. */
import { ServerSettingsForm } from "@/components/admin/server-settings";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  return (
    <RequireAccess capability="admin" title="Server settings">
      {() => <ServerSettingsForm />}
    </RequireAccess>
  );
}

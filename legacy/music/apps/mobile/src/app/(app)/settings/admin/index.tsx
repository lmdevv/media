/** F08 · Administration. */
import { AdminHub } from "@/components/admin/hub";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  return (
    <RequireAccess capability="admin" title="Administration">
      {(me) => <AdminHub me={me} />}
    </RequireAccess>
  );
}

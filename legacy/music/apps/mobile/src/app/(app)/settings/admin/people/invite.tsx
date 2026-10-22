/** F10 · Invite someone. */
import { InviteForm } from "@/components/admin/invite-form";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  return (
    <RequireAccess capability="admin" title="Invite someone">
      {(me) => <InviteForm me={me} />}
    </RequireAccess>
  );
}

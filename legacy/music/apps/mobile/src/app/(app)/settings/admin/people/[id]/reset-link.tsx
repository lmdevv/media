/** F23 · Password reset link. */
import { usePersonParam } from "@/components/admin/params";
import { ResetLinkPage } from "@/components/admin/reset-link";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  const id = usePersonParam();

  return (
    <RequireAccess capability="admin" title="Password reset link">
      {() => <ResetLinkPage id={id} />}
    </RequireAccess>
  );
}

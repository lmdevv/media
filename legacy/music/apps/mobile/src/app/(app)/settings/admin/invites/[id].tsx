/** F11 · Share the invite. */
import { InviteLink } from "@/components/admin/invite-link";
import { useInviteParam } from "@/components/admin/params";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  const id = useInviteParam();

  return (
    <RequireAccess capability="admin" title="Share the invite">
      {() => <InviteLink id={id} />}
    </RequireAccess>
  );
}

export { RouteFailure as ErrorBoundary } from "@/components/settings/route-failure";

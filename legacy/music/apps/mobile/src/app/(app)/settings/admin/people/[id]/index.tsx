/** F12 · Person. */
import { usePersonParam } from "@/components/admin/params";
import { PersonPage } from "@/components/admin/person";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  const id = usePersonParam();

  return (
    <RequireAccess capability="admin" title="Person">
      {(me) => <PersonPage me={me} id={id} />}
    </RequireAccess>
  );
}

export { RouteFailure as ErrorBoundary } from "@/components/settings/route-failure";

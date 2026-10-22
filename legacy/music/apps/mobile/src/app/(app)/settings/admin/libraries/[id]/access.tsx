/** F16 · Library access. */
import { LibraryAccessPage } from "@/components/admin/library-access";
import { useLibraryParam } from "@/components/admin/params";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  const id = useLibraryParam();

  return (
    <RequireAccess capability="admin" title="Library access">
      {(me) => <LibraryAccessPage me={me} id={id} />}
    </RequireAccess>
  );
}

export { RouteFailure as ErrorBoundary } from "@/components/settings/route-failure";

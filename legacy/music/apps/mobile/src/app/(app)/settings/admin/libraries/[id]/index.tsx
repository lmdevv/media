/** F15 · Library. */
import { LibraryPage } from "@/components/admin/library";
import { useLibraryParam } from "@/components/admin/params";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  const id = useLibraryParam();

  return (
    <RequireAccess capability="admin" title="Library">
      {(me) => <LibraryPage me={me} id={id} />}
    </RequireAccess>
  );
}

export { RouteFailure as ErrorBoundary } from "@/components/settings/route-failure";

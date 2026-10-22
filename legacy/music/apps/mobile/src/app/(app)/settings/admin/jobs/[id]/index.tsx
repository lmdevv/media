/** F19 · Library scan, and G09 when the scan stopped. */
import { JobPage } from "@/components/admin/job";
import { useJobParam } from "@/components/admin/params";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  const id = useJobParam();

  return (
    <RequireAccess capability="admin" title="Library scan">
      {() => <JobPage id={id} />}
    </RequireAccess>
  );
}

export { RouteFailure as ErrorBoundary } from "@/components/settings/route-failure";

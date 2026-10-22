/** F18 · Jobs. */
import { JobsList } from "@/components/admin/jobs-list";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  return (
    <RequireAccess capability="admin" title="Jobs">
      {() => <JobsList />}
    </RequireAccess>
  );
}

/** F17 · Add library. */
import { NewLibraryForm } from "@/components/admin/new-library";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  return (
    <RequireAccess capability="admin" title="Add library">
      {() => <NewLibraryForm />}
    </RequireAccess>
  );
}

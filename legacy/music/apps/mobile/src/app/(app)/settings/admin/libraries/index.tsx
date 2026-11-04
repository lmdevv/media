import { LibrariesList } from "@/components/admin/libraries-list";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  return (
    <RequireAccess capability="admin" title="Libraries">
      {(me) => <LibrariesList me={me} />}
    </RequireAccess>
  );
}

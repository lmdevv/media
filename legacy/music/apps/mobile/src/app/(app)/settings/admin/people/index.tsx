/** F09 · People. */
import { PeopleList } from "@/components/admin/people-list";
import { RequireAccess } from "@/components/settings/access";

export default function Screen() {
  return (
    <RequireAccess capability="admin" title="People">
      {(me) => <PeopleList me={me} />}
    </RequireAccess>
  );
}

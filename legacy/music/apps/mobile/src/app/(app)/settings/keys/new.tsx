/** F05 · New API key. */
import { RequireAccess } from "@/components/settings/access";
import { NewKey } from "@/components/settings/keys";

export default function Screen() {
  return (
    <RequireAccess capability="keys" title="New API key">
      {() => <NewKey />}
    </RequireAccess>
  );
}

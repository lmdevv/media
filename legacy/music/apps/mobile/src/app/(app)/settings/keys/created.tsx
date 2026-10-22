/** F06 · Save your key. */
import { RequireAccess } from "@/components/settings/access";
import { CreatedKey } from "@/components/settings/keys";

export default function Screen() {
  return (
    <RequireAccess capability="keys" title="Save your key">
      {() => <CreatedKey />}
    </RequireAccess>
  );
}

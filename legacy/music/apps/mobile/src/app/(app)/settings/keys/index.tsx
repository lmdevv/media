import { RequireAccess } from "@/components/settings/access";
import { KeyList } from "@/components/settings/keys";

export default function Screen() {
  return (
    <RequireAccess capability="keys" title="API keys">
      {() => <KeyList />}
    </RequireAccess>
  );
}

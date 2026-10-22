/** F07 · Revoke key?. */
import { RevokeKey } from "@/components/settings/keys";
import { SheetAccess } from "@/components/settings/sheet-access";

export default function Screen() {
  return <SheetAccess capability="keys">{() => <RevokeKey />}</SheetAccess>;
}

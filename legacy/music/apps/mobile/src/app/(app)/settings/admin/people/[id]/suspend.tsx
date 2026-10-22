/** F21 · Suspend person? */
import { usePersonParam } from "@/components/admin/params";
import { SuspendPersonSheet } from "@/components/admin/person-sheets";
import { SheetAccess } from "@/components/settings/sheet-access";

export default function Screen() {
  const id = usePersonParam();

  return (
    <SheetAccess capability="admin">{(me) => <SuspendPersonSheet me={me} id={id} />}</SheetAccess>
  );
}

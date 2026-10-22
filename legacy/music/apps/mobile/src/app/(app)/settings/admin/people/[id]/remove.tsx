/** F13 · Remove person? */
import { usePersonParam } from "@/components/admin/params";
import { RemovePersonSheet } from "@/components/admin/person-sheets";
import { SheetAccess } from "@/components/settings/sheet-access";

export default function Screen() {
  const id = usePersonParam();

  return (
    <SheetAccess capability="admin">{(me) => <RemovePersonSheet me={me} id={id} />}</SheetAccess>
  );
}

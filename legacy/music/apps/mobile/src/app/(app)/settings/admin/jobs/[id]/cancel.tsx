/** F25 · Stop this scan? */
import { CancelJobSheet } from "@/components/admin/cancel-job";
import { useJobParam } from "@/components/admin/params";
import { SheetAccess } from "@/components/settings/sheet-access";

export default function Screen() {
  const id = useJobParam();

  return <SheetAccess capability="admin">{() => <CancelJobSheet id={id} />}</SheetAccess>;
}

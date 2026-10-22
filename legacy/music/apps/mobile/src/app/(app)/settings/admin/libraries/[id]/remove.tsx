/** F24 · Remove library? */
import { useLibraryParam } from "@/components/admin/params";
import { RemoveLibrarySheet } from "@/components/admin/remove-library";
import { SheetAccess } from "@/components/settings/sheet-access";

export default function Screen() {
  const id = useLibraryParam();

  return <SheetAccess capability="admin">{() => <RemoveLibrarySheet id={id} />}</SheetAccess>;
}

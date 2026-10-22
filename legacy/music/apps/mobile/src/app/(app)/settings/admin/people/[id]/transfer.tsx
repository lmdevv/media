/** F22 · Transfer ownership? */
import { usePersonParam } from "@/components/admin/params";
import { TransferOwnershipSheet } from "@/components/admin/person-sheets";
import { SheetAccess } from "@/components/settings/sheet-access";

export default function Screen() {
  const id = usePersonParam();

  return (
    <SheetAccess capability="owner">
      {(me) => <TransferOwnershipSheet me={me} id={id} />}
    </SheetAccess>
  );
}

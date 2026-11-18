import type { HouseholdUser } from "@media/mobile-core/accounts";
import { router } from "expo-router";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { SheetLayout } from "@/components/ui/sheet-layout";
import type { UserId } from "@/lib/ids";
import { useCore } from "@/lib/platform";
import { personName } from "@/lib/people";

import { usePerson } from "./data";
import { useLastKnown } from "./use-last-known";

const useSubject = (id: UserId | null): HouseholdUser | null | undefined =>
  useLastKnown(usePerson(id));

function Missing() {
  return <SheetLayout title="Not on this server" subtitle="They may have been removed already." />;
}

/** F22 · Make an admin the owner; the caller becomes an admin. */
export function TransferOwnershipSheet({ id }: { readonly id: UserId | null }) {
  const person = useSubject(id);
  const core = useCore();

  if (person === undefined) return null;

  if (person === null) return <Missing />;

  const name = personName(person);

  return (
    <ConfirmSheet
      title={`Make ${name} the owner?`}
      body={`There is one owner. ${name} will have full control of the server and you’ll become an admin. Only ${name} can transfer it back.`}
      confirmLabel={`Make ${name} owner`}
      pendingLabel="Transferring…"
      tone="primary"
      onConfirm={async () => {
        await core.accounts.users.handOverOwnership({ userId: person.userId });
        router.back();
      }}
    />
  );
}

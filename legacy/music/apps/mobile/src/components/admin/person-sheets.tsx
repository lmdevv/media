/**
 * F13, F21, F22 · The confirmations for removing, suspending, and making someone the owner, with
 * Paper's copy and the person's name.
 */
import type { UserId } from "@music/commands/ids";
import type { Person, User } from "@music/commands/models";
import { useRead, useRun } from "@music/sdk/react";
import { router } from "expo-router";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { personName } from "@/lib/people";

import { usePerson } from "./data";
import { useLastKnown } from "./use-last-known";

/** Props for each person confirmation. */
export interface PersonSheetProps {
  readonly me: User;
  readonly id: UserId | null;
}

/**
 * The person a sheet confirms an action on, kept once the action removes them, and the sheet
 * to show while they load or when they were never there.
 */
const useSubject = (id: UserId | null): Person | null | undefined => useLastKnown(usePerson(id));

function Missing() {
  return <SheetLayout title="Not on this server" subtitle="They may have been removed already." />;
}

/** F13 · Remove someone, their data with them; their libraries move to the server's owner. */
export function RemovePersonSheet({ me, id }: PersonSheetProps) {
  const person = useSubject(id);
  const people = useRead("people.list", {});
  const remove = useRun("people.remove");

  if (person === undefined) return null;

  if (person === null) return <Missing />;

  const name = personName(person);
  const owner = people?.find((someone) => someone.role === "owner");
  const heir = me.role === "owner" || owner === undefined ? "you" : personName(owner);

  return (
    <ConfirmSheet
      title={`Remove ${name}?`}
      body={`Signs ${name} out and deletes their playlists, likes, history, devices, and API keys. Their library folders move to ${heir}. Music files stay on disk. This can’t be undone.`}
      confirmLabel={`Remove ${name}`}
      pendingLabel="Removing…"
      onConfirm={async () => {
        await remove({ userId: person.id });
        router.dismissTo("/settings/admin/people");
      }}
    />
  );
}

/** F21 · Suspend someone: signed out everywhere, their data kept. */
export function SuspendPersonSheet({ id }: PersonSheetProps) {
  const person = useSubject(id);
  const suspend = useRun("people.suspend");

  if (person === undefined) return null;

  if (person === null) return <Missing />;

  const name = personName(person);

  return (
    <ConfirmSheet
      title={`Suspend ${name}?`}
      body={`${name} is signed out everywhere and can’t sign in. Their API keys stop working. Their playlists and likes stay. You can unsuspend them later.`}
      confirmLabel={`Suspend ${name}`}
      pendingLabel="Suspending…"
      onConfirm={async () => {
        await suspend({ userId: person.id });
        router.back();
      }}
    />
  );
}

/** F22 · Make an admin the owner; the caller becomes an admin. */
export function TransferOwnershipSheet({ id }: PersonSheetProps) {
  const person = useSubject(id);
  const transfer = useRun("people.transfer");

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
        await transfer({ userId: person.id });
        router.back();
      }}
    />
  );
}

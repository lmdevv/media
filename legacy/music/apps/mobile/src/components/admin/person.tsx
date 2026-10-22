/**
 * F12 · Person: who they are, their role, and what an admin may do to their account. A role chip
 * changes the role at once; the reset link is made on press, never on arrival. Everything the
 * caller may not do is hidden, with a note saying why.
 */
import type { UserId } from "@music/commands/ids";
import type { AssignableRole, Person, User } from "@music/commands/models";
import {
  assignableRoles,
  canManagePerson,
  canTransferOwnership,
  roleLabel,
} from "@music/commands/permissions";
import { useRun } from "@music/sdk/react";
import { router } from "expo-router";
import { Key, Lock, LockOpen, Monitor, Trash2, Users } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { ChipGroup } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { assignedRole, manageNote, personName } from "@/lib/people";

import { usePerson } from "./data";
import { Failure } from "@/components/settings/failure";
import { NavGlyph } from "@/components/settings/nav-glyph";
import { holdSecret } from "@/components/settings/secret-slot";
import { useAction } from "@/components/settings/use-action";

/** One person's page, for an admin or the owner. */
export function PersonPage({ me, id }: { readonly me: User; readonly id: UserId | null }) {
  const person = usePerson(id);

  if (person === undefined) {
    return (
      <Page title="" bottom="plain">
        {null}
      </Page>
    );
  }

  if (person === null) {
    return (
      <Page title="Person" bottom="plain">
        <EmptyState
          icon={Users}
          title={"Not on this\nserver."}
          body={"They were removed,\nor this link is out of date."}
        />
      </Page>
    );
  }

  return <PersonControls me={me} person={person} />;
}

/** The person's role and account controls, once they have loaded. */
function PersonControls({ me, person }: { readonly me: User; readonly person: Person }) {
  const changeRole = useRun("people.role");
  const createReset = useRun("people.reset");
  const unsuspend = useRun("people.unsuspend");
  const roleChange = useAction();
  const reset = useAction();
  const restore = useAction();
  // The chip someone just picked, shown while the change runs; the saved role otherwise.
  const [picked, setPicked] = useState<AssignableRole | null>(null);
  const name = personName(person);
  const role = picked ?? assignedRole(person.role);
  const manageable = canManagePerson(me, person);
  const params = { id: person.id };

  const pickRole = (next: AssignableRole) => {
    setPicked(next);

    roleChange.run(async () => {
      try {
        await changeRole({ userId: person.id, role: next });
      } finally {
        setPicked(null);
      }
    });
  };

  const makeResetLink = () =>
    reset.run(async () => {
      const link = await createReset({ userId: person.id });

      holdSecret(link.token);
      router.push({
        pathname: "/settings/admin/people/[id]/reset-link",
        params: { id: person.id, expiresAt: String(link.expiresAt) },
      });
    });

  const note = manageable ? null : manageNote(me, { id: person.id, role: person.role, name });

  return (
    <Page title={name} bottom="plain" trailing={<NavGlyph icon={Users} />}>
      <Row
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        title={name}
        subtitle={`${person.email} · ${person.suspended ? "Suspended" : "Active"}`}
      />
      {note === null ? null : (
        <View className="pt-4">
          <Notice icon={Lock} title={note.title} body={note.body} />
        </View>
      )}
      {!manageable || role === null ? null : (
        <>
          <SectionHeader title="Server role" />
          <ChipGroup
            label="Server role"
            options={assignableRoles(me.role).map((option) => ({
              value: option,
              label: roleLabel(option),
            }))}
            value={role}
            onChange={pickRole}
          />
          <Row
            leading={{ kind: "icon", icon: Key, tone: "muted" }}
            title="Create password reset link"
            subtitle={reset.pending ? "Creating link…" : "One-time link · Valid for 24 hours"}
            trailing={<RowChevron />}
            onPress={makeResetLink}
          />
          {person.suspended ? (
            <Row
              leading={{ kind: "icon", icon: LockOpen, tone: "muted" }}
              title="Unsuspend account"
              subtitle={restore.pending ? "Unsuspending…" : "Let them sign in again"}
              onPress={() =>
                restore.run(async () => {
                  await unsuspend({ userId: person.id });
                })
              }
            />
          ) : (
            <Row
              leading={{ kind: "icon", icon: Lock, tone: "muted" }}
              title="Suspend account"
              subtitle="Sign out everywhere; keep their data"
              trailing={<RowChevron />}
              onPress={() =>
                router.push({ pathname: "/settings/admin/people/[id]/suspend", params })
              }
            />
          )}
          {canTransferOwnership(me, person) ? (
            <Row
              leading={{ kind: "icon", icon: Monitor, tone: "muted" }}
              title="Transfer server ownership"
              subtitle="Make this admin the server owner"
              trailing={<RowChevron />}
              onPress={() =>
                router.push({ pathname: "/settings/admin/people/[id]/transfer", params })
              }
            />
          ) : null}
          <Row
            leading={{ kind: "icon", icon: Trash2, tone: "muted" }}
            title="Remove from server"
            subtitle="Delete this person’s account and data"
            trailing={<RowChevron />}
            onPress={() => router.push({ pathname: "/settings/admin/people/[id]/remove", params })}
          />
        </>
      )}
      <Failure message={roleChange.failure ?? reset.failure ?? restore.failure} />
    </Page>
  );
}

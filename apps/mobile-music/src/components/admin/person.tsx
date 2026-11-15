import { canChangeRole, ROLE_LABELS } from "@media/mobile-core/accounts";
import type { AssignableRole, HouseholdUser } from "@media/mobile-core/accounts";
import { router } from "expo-router";
import { Key, Lock, Monitor, Users } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { ChipGroup } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import type { UserId } from "@/lib/ids";
import type { Me } from "@/lib/models";
import { useCore } from "@/lib/platform";
import { ROLE_OPTIONS, assignedRole, manageNote, personName } from "@/lib/people";

import { Failure } from "@/components/settings/failure";
import { NavGlyph } from "@/components/settings/nav-glyph";
import { holdSecret } from "@/components/settings/secret-slot";
import { useAction } from "@/components/settings/use-action";

import { usePerson } from "./data";

/** One person's page, for an admin or the owner. */
export function PersonPage({ me, id }: { readonly me: Me; readonly id: UserId | null }) {
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

function PersonControls({ me, person }: { readonly me: Me; readonly person: HouseholdUser }) {
  const core = useCore();
  const roleChange = useAction();
  const reset = useAction();
  const [picked, setPicked] = useState<AssignableRole | null>(null);
  const name = personName(person);
  const role = picked ?? assignedRole(person.role);
  const note = manageNote(me.userId, person);
  const manageable = canChangeRole(person, me.userId);
  const params = { id: person.userId };

  const pickRole = (next: AssignableRole) => {
    setPicked(next);

    roleChange.run(async () => {
      try {
        await core.accounts.users.setRole({ userId: person.userId, role: next });
      } finally {
        setPicked(null);
      }
    });
  };

  const makeResetLink = () =>
    reset.run(async () => {
      const link = await core.accounts.resetLinks.create({ userId: person.userId });

      holdSecret(link.code);
      router.push({
        pathname: "/settings/admin/people/[id]/reset-link",
        params: { id: person.userId, expiresAt: String(link.expiresAt) },
      });
    });

  return (
    <Page title={name} bottom="plain" trailing={<NavGlyph icon={Users} />}>
      <Row
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        title={name}
        subtitle={`${person.username} · ${ROLE_LABELS[person.role]}`}
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
            options={ROLE_OPTIONS.map((option) => ({ value: option, label: ROLE_LABELS[option] }))}
            value={role}
            onChange={pickRole}
          />
        </>
      )}
      {note === null ? (
        <Row
          leading={{ kind: "icon", icon: Key, tone: "muted" }}
          title="Create password reset link"
          subtitle={reset.pending ? "Creating link…" : "One-time link · Valid for 24 hours"}
          trailing={<RowChevron />}
          onPress={makeResetLink}
        />
      ) : null}
      {me.role === "owner" && person.role === "admin" ? (
        <Row
          leading={{ kind: "icon", icon: Monitor, tone: "muted" }}
          title="Transfer server ownership"
          subtitle="Make this admin the server owner"
          trailing={<RowChevron />}
          onPress={() => router.push({ pathname: "/settings/admin/people/[id]/transfer", params })}
        />
      ) : null}
      <Failure message={roleChange.failure ?? reset.failure} />
    </Page>
  );
}

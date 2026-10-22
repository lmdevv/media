/**
 * F10 · Invite someone: an optional email that limits who can use the link, and the role it
 * gives. Creating it replaces this page with the link to share (F11), so Back goes to People.
 */
import type { AssignableRole, User } from "@music/commands/models";
import { assignableRoles, roleLabel } from "@music/commands/permissions";
import { useRun } from "@music/sdk/react";
import { router } from "expo-router";
import { Users } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Headline } from "@/components/settings/headline";
import { Button } from "@/components/ui/button";
import { ChipGroup } from "@/components/ui/chip";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { SectionHeader } from "@/components/ui/section-header";
import { ROLE_ACCESS, inviteRoles } from "@/lib/people";

import { NavGlyph } from "@/components/settings/nav-glyph";
import { useAction } from "@/components/settings/use-action";

/** Something that reads as an email address; the server checks the rest. */
const EMAIL = /^[^\s@]+@[^\s@]+$/u;

/** The new-invite form. */
export function InviteForm({ me }: { readonly me: User }) {
  const create = useRun("invites.create");
  const action = useAction();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [problem, setProblem] = useState<string | null>(null);
  const roles = inviteRoles(assignableRoles(me.role));
  const access = ROLE_ACCESS[role];

  const submit = () => {
    const trimmed = email.trim();

    if (trimmed.length > 0 && !EMAIL.test(trimmed)) {
      setProblem("Enter an email address, or leave it empty for anyone with the link.");

      return;
    }

    setProblem(null);

    action.run(async () => {
      const invite = await create(trimmed.length === 0 ? { role } : { email: trimmed, role });
      router.replace({ pathname: "/settings/admin/invites/[id]", params: { id: invite.id } });
    });
  };

  return (
    <Page title="Invite someone" bottom="plain" trailing={<NavGlyph icon={Users} />}>
      <Headline top="compact">{"More people.\nMore good music."}</Headline>
      <Field
        label="Email (optional)"
        helper="An email restricts the invite to that person."
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="off"
        returnKeyType="done"
        error={problem ?? action.failure}
      />
      <SectionHeader title="Role" />
      <ChipGroup
        label="Role"
        options={roles.map((option) => ({ value: option, label: roleLabel(option) }))}
        value={role}
        onChange={setRole}
      />
      <Notice icon={Users} title={access.title} body={access.body} />
      <View className="pt-6">
        <Button
          label="Create invite"
          pendingLabel="Creating…"
          pending={action.pending}
          onPress={submit}
        />
      </View>
    </Page>
  );
}

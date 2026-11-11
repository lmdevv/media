import type { CreatedInvite } from "@media/contracts/models/account";
import type { AssignableRole } from "@media/contracts/scopes";
import { useCommand } from "@media/sdk/react";
import { router } from "expo-router";
import { Share as ShareIcon, ShieldCheck, User } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useState } from "react";
import { Share } from "react-native";

import { OwnerScreen, SectionHeading } from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { expiryLine } from "@/lib/household";

const DAYS = 7;

const ROLES: ReadonlyArray<{
  readonly role: AssignableRole;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { role: "member", label: "Member", icon: User },
  { role: "admin", label: "Admin", icon: ShieldCheck },
];

function InviteReady({ created }: { readonly created: CreatedInvite }) {
  return (
    <>
      <Text variant="label" tone="muted">
        {created.invite.email === null ? "Invite Link" : `Invite Link for ${created.invite.email}`}
      </Text>
      <Text variant="mono" selectable>
        {created.url}
      </Text>
      <Button
        label="Share Invite"
        icon={ShareIcon}
        onPress={() => void Share.share({ url: created.url })}
      />
      <Button label="Done" variant="secondary" onPress={() => router.back()} />
      <Text variant="secondary" tone="muted">
        {`${expiryLine(DAYS)} · Works once`}
      </Text>
    </>
  );
}

export default function InviteSomeone() {
  const create = useCommand("invites.create");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  const submit = useTask(async () => {
    const address = email.trim();

    setCreated(
      await create(
        address === ""
          ? { role, expiresInDays: DAYS }
          : { email: address, role, expiresInDays: DAYS },
      ),
    );
  });

  if (created !== null) {
    return (
      <OwnerScreen title="Invite Someone" fallback="/owner/users">
        <InviteReady created={created} />
      </OwnerScreen>
    );
  }

  return (
    <OwnerScreen title="Invite Someone" fallback="/owner/users">
      <TextField
        label="Email"
        placeholder="Optional"
        value={email}
        onChangeText={(text) => {
          setEmail(text);
          submit.clearError();
        }}
        error={submit.error}
        autoCapitalize="none"
        keyboardType="email-address"
        textContentType="emailAddress"
        autoComplete="email"
      />
      <SectionHeading>Role</SectionHeading>
      {ROLES.map((each) => (
        <ListRow
          key={each.role}
          icon={each.icon}
          title={each.label}
          detail={each.role === role ? "Selected" : undefined}
          chevron={false}
          onPress={() => setRole(each.role)}
        />
      ))}
      <Button label="Create Invite" busy={submit.busy} onPress={() => void submit.run()} />
      <Text variant="secondary" tone="muted">
        {expiryLine(DAYS)}
      </Text>
    </OwnerScreen>
  );
}

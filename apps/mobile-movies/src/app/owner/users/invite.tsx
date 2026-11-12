import { INVITE_DAYS, ROLE_LABELS, accountUrlOf, expiryLine } from "@media/mobile-core/accounts";
import type { AssignableRole } from "@media/mobile-core/accounts";
import { useMakeInvite } from "@media/mobile-core/use-accounts";
import type { MadeInvite } from "@media/mobile-core/use-accounts";
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
import { useServer } from "@/session/connection";

const ROLES: ReadonlyArray<{ readonly role: AssignableRole; readonly icon: LucideIcon }> = [
  { role: "member", icon: User },
  { role: "admin", icon: ShieldCheck },
];

function InviteReady({ made }: { readonly made: MadeInvite }) {
  return (
    <>
      <Text variant="label" tone="muted">
        Invite Link
      </Text>
      <Text variant="mono" selectable>
        {made.link}
      </Text>
      <Button
        label="Share Invite"
        icon={ShareIcon}
        onPress={() => void Share.share({ url: made.link })}
      />
      <Button label="Done" variant="secondary" onPress={() => router.back()} />
      <Text variant="secondary" tone="muted">
        {`${expiryLine(INVITE_DAYS)} · Works once`}
      </Text>
    </>
  );
}

export default function InviteSomeone() {
  const { moviesUrl } = useServer();
  const makeInvite = useMakeInvite(accountUrlOf(moviesUrl));
  const [role, setRole] = useState<AssignableRole>("member");
  const [made, setMade] = useState<MadeInvite | null>(null);

  const submit = useTask(async () => {
    setMade(await makeInvite(role));
  });

  if (made !== null) {
    return (
      <OwnerScreen title="Invite Someone" fallback="/owner/users">
        <InviteReady made={made} />
      </OwnerScreen>
    );
  }

  return (
    <OwnerScreen title="Invite Someone" fallback="/owner/users">
      <SectionHeading>Role</SectionHeading>
      {ROLES.map((each) => (
        <ListRow
          key={each.role}
          icon={each.icon}
          title={ROLE_LABELS[each.role]}
          detail={each.role === role ? "Selected" : undefined}
          chevron={false}
          onPress={() => setRole(each.role)}
        />
      ))}
      {submit.error === null ? null : (
        <Text variant="meta" tone="danger">
          {submit.error}
        </Text>
      )}
      <Button label="Create Invite" busy={submit.busy} onPress={() => void submit.run()} />
      <Text variant="secondary" tone="muted">
        {expiryLine(INVITE_DAYS)}
      </Text>
    </OwnerScreen>
  );
}

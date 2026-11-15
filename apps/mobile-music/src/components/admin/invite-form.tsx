import { ROLE_LABELS } from "@media/mobile-core/accounts";
import type { AssignableRole } from "@media/mobile-core/accounts";
import { useMakeInvite } from "@media/mobile-core/use-accounts";
import { router } from "expo-router";
import { Users } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Headline } from "@/components/settings/headline";
import { Button } from "@/components/ui/button";
import { ChipGroup } from "@/components/ui/chip";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { SectionHeader } from "@/components/ui/section-header";
import { ROLE_ACCESS, ROLE_OPTIONS } from "@/lib/people";
import { useConnection } from "@/session/connection";

import { NavGlyph } from "@/components/settings/nav-glyph";
import { holdSecret } from "@/components/settings/secret-slot";
import { useAction } from "@/components/settings/use-action";

/**
 * The new-invite form. The core makes the code and shows it once, so the link goes to the next
 * page through the secret slot, as a new API key's secret does, and never back to the server.
 */
export function InviteForm() {
  const { mediaUrl } = useConnection();
  const makeInvite = useMakeInvite(mediaUrl);
  const action = useAction();
  const [role, setRole] = useState<AssignableRole>("member");
  const access = ROLE_ACCESS[role];

  const submit = () => {
    action.run(async () => {
      const invite = await makeInvite(role);

      holdSecret(invite.link);
      router.replace({
        pathname: "/settings/admin/invites/[id]",
        params: { id: "new", role, expiresAt: String(invite.expiresAt) },
      });
    });
  };

  return (
    <Page title="Invite someone" bottom="plain" trailing={<NavGlyph icon={Users} />}>
      <Headline top="compact">{"More people.\nMore good music."}</Headline>
      <SectionHeader title="Role" />
      <ChipGroup
        label="Role"
        options={ROLE_OPTIONS.map((option) => ({ value: option, label: ROLE_LABELS[option] }))}
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
      {action.failure === null ? null : (
        <Notice icon={Users} title="Couldn’t create the invite" body={action.failure} />
      )}
    </Page>
  );
}

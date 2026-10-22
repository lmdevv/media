/**
 * F11 · Share the invite: the one-time link for an open invite, to share or copy, and a way to
 * revoke it. Paper doesn't draw Revoke; the web app offers it, so the phone does too.
 */
import type { InviteId } from "@music/commands/ids";
import { useRun } from "@music/sdk/react";
import { router } from "expo-router";
import { Check, Link, Share, Users } from "lucide-react-native";
import { useState } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";

import { copyText, shareLink } from "@/components/settings/clipboard";
import { Headline } from "@/components/settings/headline";
import { ValueField } from "@/components/settings/value-field";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Page } from "@/components/ui/page";
import { Row } from "@/components/ui/row";
import { inviteLink } from "@/lib/links";
import { invitedAs, inviteTitle } from "@/lib/people";
import { until } from "@/lib/when";
import { useConnection } from "@/session/connection";

import { useInvite } from "./data";
import { Failure } from "@/components/settings/failure";
import { useAction } from "@/components/settings/use-action";
import { useFlash } from "@/components/settings/use-flash";
import { useNow } from "@/components/settings/use-now";

/** F11's chrome: the title, and the check that closes the page. */
function InvitePage({ children }: { readonly children?: ReactNode }) {
  return (
    <Page
      title="Share the invite"
      bottom="plain"
      trailing={<IconButton icon={Check} label="Done" onPress={() => router.back()} />}
    >
      {children}
    </Page>
  );
}

/** An invite's link, ready to hand over. */
export function InviteLink({ id }: { readonly id: InviteId | null }) {
  const { origin } = useConnection();
  const invite = useInvite(id);
  const revoke = useRun("invites.revoke");
  const action = useAction();
  const now = useNow(60_000);
  const [copied, flashCopied] = useFlash();
  // Revoking takes the invite off the list before this page closes; show nothing meanwhile
  // rather than "gone".
  const [leaving, setLeaving] = useState(false);
  const left = invite === undefined || invite === null ? null : until(invite.expiresAt, now);

  if (invite === undefined || (invite === null && (action.pending || leaving))) {
    return <InvitePage />;
  }

  if (invite === null || left === null || invite.status !== "open") {
    return (
      <InvitePage>
        <EmptyState
          icon={Link}
          title={"This invite\nis gone."}
          body={"It was used, revoked,\nor it expired."}
          primary={
            <Button
              label="New invite"
              onPress={() => router.replace("/settings/admin/people/invite")}
            />
          }
        />
      </InvitePage>
    );
  }

  const link = inviteLink(origin, invite.code);

  const cancel = () =>
    action.run(async () => {
      await revoke({ inviteId: invite.id });
      setLeaving(true);
      router.back();
    });

  return (
    <InvitePage>
      <Headline top="loose">{"Their next favorite\nsong is here."}</Headline>
      <Row
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        title={inviteTitle(invite)}
        subtitle={invitedAs(invite.role)}
      />
      <ValueField
        label="One-time invite link"
        value={link}
        helper={`Works once · Expires ${left}.`}
      />
      <View className="pt-6">
        <Button label="Share invite" icon={Share} onPress={() => void shareLink(link)} />
      </View>
      <View className="pt-3">
        <Button
          label={copied ? "Copied" : "Copy link"}
          variant="secondary"
          onPress={() => void copyText(link).then(flashCopied)}
        />
      </View>
      <View className="pt-6">
        <Button
          label="Revoke invite"
          pendingLabel="Revoking…"
          variant="destructive"
          pending={action.pending}
          onPress={cancel}
        />
      </View>
      <Failure message={action.failure} />
    </InvitePage>
  );
}

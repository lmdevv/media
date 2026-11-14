import { useRevokeInvite } from "@media/mobile-core/use-accounts";
import { Option, Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
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
import type { InviteId } from "@/lib/ids";
import { invitedAs, inviteTitle } from "@/lib/people";
import { until } from "@/lib/when";

import { Failure } from "@/components/settings/failure";
import { useHeldSecret } from "@/components/settings/secret-slot";
import { useAction } from "@/components/settings/use-action";
import { useFlash } from "@/components/settings/use-flash";
import { useNow } from "@/components/settings/use-now";

import { useInvite } from "./data";

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

const NewInvite = Schema.Struct({
  role: Schema.Literals(["member", "admin"]),
  expiresAt: Schema.FiniteFromString,
});

const decodeNew = Schema.decodeUnknownOption(NewInvite);

/**
 * A new invite's link, once: the form left it in the secret slot, which this page empties on its
 * first render, so coming back never shows it again. Old music kept every invite's link; the core
 * keeps only a hash of its code.
 */
function NewInviteLink() {
  const link = useHeldSecret();
  const invite = Option.getOrNull(decodeNew(useLocalSearchParams()));
  const now = useNow(60_000);
  const [copied, flashCopied] = useFlash();
  const left = invite === null ? null : until(invite.expiresAt, now);

  if (link === null || invite === null || left === null) {
    return (
      <InvitePage>
        <EmptyState
          icon={Link}
          title={"The link was\nshown once."}
          body={"If you didn’t share it, revoke the\ninvite in People and make another."}
          primary={<Button label="Back to People" onPress={() => router.back()} />}
        />
      </InvitePage>
    );
  }

  return (
    <InvitePage>
      <Headline top="loose">{"Their next favorite\nsong is here."}</Headline>
      <Row
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        title="Anyone with the link"
        subtitle={invitedAs(invite.role)}
      />
      <ValueField
        label="One-time invite link"
        value={link}
        helper={`Works once · Expires ${left}. Shown only now.`}
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
    </InvitePage>
  );
}

/** An open invite: who made it, what it gives, when it stops working, and Revoke. */
function OpenInvite({ id }: { readonly id: InviteId | null }) {
  const invite = useInvite(id);
  const revoke = useRevokeInvite();
  const action = useAction();
  const now = useNow(60_000);
  const [leaving, setLeaving] = useState(false);
  const left = invite === undefined || invite === null ? null : until(invite.expiresAt, now);

  if (invite === undefined || (invite === null && (action.pending || leaving))) {
    return <InvitePage />;
  }

  if (invite === null || left === null) {
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

  const cancel = () =>
    action.run(async () => {
      await revoke(invite);
      setLeaving(true);
      router.back();
    });

  return (
    <InvitePage>
      <Row
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        title={inviteTitle(invite)}
        subtitle={`${invitedAs(invite.role)} · Expires ${left}`}
      />
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

/** An invite's page: a new one's link, shown once, or an open one to revoke. */
export function InviteLink({ id }: { readonly id: InviteId | null }) {
  const { id: raw } = useLocalSearchParams<{ id?: string }>();

  return raw === "new" ? <NewInviteLink /> : <OpenInvite id={id} />;
}

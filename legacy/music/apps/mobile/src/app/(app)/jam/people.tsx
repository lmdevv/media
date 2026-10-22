/**
 * D03 · People in the Jam. The host lets people waiting in or turns them away, and opens a member
 * to remove them; plus shares the link. A member sees who is in it.
 */
import type { UserId } from "@music/commands/ids";
import type { Jam, JamMember } from "@music/commands/models";
import { errorMessage } from "@music/sdk/errors";
import { useRead, useRun } from "@music/sdk/react";
import { router } from "expo-router";
import { Check, ListOrdered, Plus, Smartphone, Users } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { useJamLink } from "@/components/jams/use-jam-link";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { jamPeople, memberStatus } from "@/lib/jam";
import { useNowPlaying } from "@/player";

/** Someone waiting: their row, then Let in and Decline. */
function Request({ member }: { readonly member: JamMember }) {
  const approve = useRun("jam.approve");
  const [pending, setPending] = useState<"in" | "out" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const userId: UserId = member.person.id;

  const decide = async (letIn: boolean) => {
    setPending(letIn ? "in" : "out");
    setFailure(null);

    try {
      await approve({ userId, approve: letIn });
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t do that. Try again.");
      setPending(null);
    }
  };

  return (
    <View>
      <Row
        title={member.person.name}
        subtitle="Wants to join your Jam"
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
      />
      <View className="flex-row gap-3 py-3">
        <Button
          label="Let in"
          pendingLabel="Letting in…"
          icon={Check}
          pending={pending === "in"}
          disabled={pending === "out"}
          onPress={() => void decide(true)}
          className="flex-1"
        />
        <Button
          label="Decline"
          pendingLabel="Declining…"
          variant="secondary"
          pending={pending === "out"}
          disabled={pending === "in"}
          onPress={() => void decide(false)}
          className="flex-1"
        />
      </View>
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pb-2">
          {failure}
        </Text>
      )}
    </View>
  );
}

/** The people list for the Jam the person is in. */
function People({ jam }: { readonly jam: Jam }) {
  const { role } = useNowPlaying();
  const { share } = useJamLink(jam.code);
  const host = jam.role === "host";
  const { joined, waiting } = jamPeople(jam.members);

  return (
    <Page
      title="People"
      bottom="plain"
      trailing={host ? <IconButton icon={Plus} label="Invite people" onPress={share} /> : undefined}
    >
      {host && waiting.length > 0 ? (
        <>
          <SectionHeader title="Waiting to join" />
          {waiting.map((member) => (
            <Request key={member.person.id} member={member} />
          ))}
        </>
      ) : null}
      <SectionHeader title="In this Jam" />
      <Row
        title={host ? "You" : jam.host.name}
        subtitle={host && role.kind === "local" ? "Host · Playing on this iPhone" : "Host"}
        leading={{ kind: "icon", icon: Smartphone, tone: "muted" }}
      />
      {joined.map((member) => (
        <Row
          key={member.person.id}
          title={member.person.name}
          subtitle={memberStatus(member, jam.settings)}
          leading={{ kind: "icon", icon: Users, tone: "muted" }}
          trailing={host ? <RowChevron /> : undefined}
          {...(host
            ? {
                onPress: () => {
                  router.push({
                    pathname: "/jam/remove/[userId]",
                    params: { userId: member.person.id },
                  });
                },
                accessibilityLabel: `${member.person.name}, ${memberStatus(member, jam.settings)}. Opens remove`,
              }
            : {})}
        />
      ))}
      <Notice
        icon={ListOrdered}
        title="Everyone shares one queue"
        body={
          host
            ? "Your permissions decide what members can change."
            : `${jam.host.name}’s permissions decide what you can change.`
        }
        className="mt-6"
      />
    </Page>
  );
}

export default function Screen() {
  const jam = useRead("jam.get", {});

  if (jam === undefined || jam === null || jam.status !== "active") {
    return (
      <Page title="People" bottom="plain">
        {null}
      </Page>
    );
  }

  return <People jam={jam} />;
}

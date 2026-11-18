import { describeFailure } from "@media/mobile-core/failure";
import { MUSIC, shownName, useMusicSession } from "@media/player/session-react";
import type { JoinedSession } from "@media/player/session-react";
import { usePlatform } from "@media/sdk/react";
import { Users } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Page } from "@/components/ui/page";
import { Row } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";

type PersonId = JoinedSession["members"][number]["userId"];

/**
 * The line under someone's name: their username first when they go by another name, since only
 * they have it, then `line`.
 */
const withUsername = (
  person: { readonly username: string; readonly displayName: string | null },
  line: string,
): string => (person.displayName === null ? line : `${person.username} · ${line}`);

/** Who is in the Jam and who waits to join; the host lets people in, turns them away, or removes them. */
export default function JamPeople() {
  const platform = usePlatform();
  const { view } = useMusicSession();
  const [failure, setFailure] = useState<string | null>(null);

  if (view?.state !== "joined") {
    return (
      <Page title="People" bottom="plain">
        {null}
      </Page>
    );
  }

  const hosting = view.role === "host";
  const waiting = view.pending ?? [];

  const act = (call: Promise<unknown>) => {
    setFailure(null);
    call.catch((cause: unknown) => {
      setFailure(describeFailure(cause));
    });
  };

  const block = (userId: PersonId) => platform.core.together.block({ domain: MUSIC, userId });

  return (
    <Page title="People" bottom="plain">
      {hosting && waiting.length > 0 ? (
        <>
          <SectionHeader title="Waiting to join" first />
          {waiting.map((person) => (
            <View key={person.userId} className="gap-2 pb-3">
              <Row
                title={shownName(person)}
                subtitle={withUsername(person, "Wants to join")}
                leading={{ kind: "icon", icon: Users, tone: "accent" }}
              />
              <View className="flex-row gap-3">
                <Button
                  label="Let in"
                  className="flex-1"
                  onPress={() => {
                    act(platform.core.together.admit({ domain: MUSIC, userId: person.userId }));
                  }}
                />
                <Button
                  label="Turn away"
                  variant="secondary"
                  className="flex-1"
                  onPress={() => {
                    act(block(person.userId));
                  }}
                />
              </View>
            </View>
          ))}
        </>
      ) : null}
      <SectionHeader title="In this Jam" first={!hosting || waiting.length === 0} />
      {view.members.map((member) => (
        <Row
          key={member.userId}
          title={shownName(member)}
          subtitle={withUsername(
            member,
            member.role === "host" ? "Host" : member.present ? "Listening" : "Away",
          )}
          leading={{ kind: "icon", icon: Users, tone: "muted" }}
          {...(hosting && member.role === "guest"
            ? {
                trailingAction: (
                  <Button
                    label="Remove"
                    variant="destructive"
                    onPress={() => {
                      act(block(member.userId));
                    }}
                  />
                ),
              }
            : {})}
        />
      ))}
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-2">
          {failure}
        </Text>
      )}
    </Page>
  );
}

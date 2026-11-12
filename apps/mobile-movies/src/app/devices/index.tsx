import { useAllPages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
import { router } from "expo-router";
import { Airplay, Monitor, Plus, Smartphone } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { listedSessions, sessionDetail, sessionName } from "@/lib/account";
import type { Session } from "@/lib/account";

const sessionIcon = (session: Session) => {
  if (session.current) return Smartphone;

  return session.kind === "deviceCode" || session.kind === "tile" ? Airplay : Monitor;
};

/** The person's own signed-in browsers, apps, and devices; each but this one signs out. */
export default function Devices() {
  const platform = usePlatform();

  const sessions = useAllPages(platform.core.auth.sessions.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const [now] = useState(Date.now);

  if (sessions.status === "failed") {
    return (
      <Screen readable header={<NavHeader title="Devices" fallback="/you" />}>
        <CalmState
          title="Couldn’t Load Devices"
          description={sessions.message}
          actions={<Button label="Try Again" onPress={sessions.retry} />}
        />
      </Screen>
    );
  }

  return (
    <Screen readable scroll header={<NavHeader title="Devices" fallback="/you" />}>
      {sessions.status === "loading" ? (
        <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
      ) : (
        <>
          {listedSessions(sessions.rows).map((session) => (
            <ListRow
              key={session.sessionId}
              icon={sessionIcon(session)}
              title={sessionName(session)}
              detail={sessionDetail(session, now)}
              {...(session.current
                ? {}
                : {
                    onPress: () =>
                      router.push({
                        pathname: "/devices/sign-out",
                        params: { sessionId: session.sessionId, name: sessionName(session) },
                      }),
                  })}
            />
          ))}
          {sessions.next.kind === "loading" || sessions.next.kind === "more" ? (
            <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
          ) : null}
          {sessions.next.kind === "failed" ? (
            <Button label="Try Again" variant="plain" onPress={sessions.next.retry} />
          ) : null}
        </>
      )}
      <View className="h-6" />
      <Button
        label="Approve a Device"
        variant="secondary"
        icon={Plus}
        onPress={() => router.push("/approve-device")}
      />
    </Screen>
  );
}

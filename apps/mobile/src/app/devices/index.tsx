import type { SessionInfo } from "@media/contracts/models/account";
import { useCommandQuery } from "@media/sdk/react";
import { router } from "expo-router";
import { Airplay, Monitor, Plus, Smartphone } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { deviceDetail, deviceName, listedDevices } from "@/lib/account";
import { describeFailure } from "@/lib/failure";

const deviceIcon = (session: SessionInfo) => {
  if (session.current) return Smartphone;

  return session.kind === "device" ? Airplay : Monitor;
};

export default function Devices() {
  const sessions = useCommandQuery("sessions.list", {});
  const [now] = useState(Date.now);

  if (sessions.status === "error") {
    return (
      <Screen readable header={<NavHeader title="Devices" fallback="/you" />}>
        <CalmState
          title="Couldn’t Load Devices"
          description={describeFailure(sessions.error)}
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
        listedDevices(sessions.data).map((session) => (
          <ListRow
            key={session.id}
            icon={deviceIcon(session)}
            title={deviceName(session)}
            detail={deviceDetail(session, now)}
            {...(session.current
              ? {}
              : {
                  onPress: () =>
                    router.push({
                      pathname: "/devices/sign-out",
                      params: { sessionId: session.id, name: deviceName(session) },
                    }),
                })}
          />
        ))
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

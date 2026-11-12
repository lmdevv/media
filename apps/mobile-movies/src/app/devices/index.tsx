import { useAllPages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
import { router } from "expo-router";
import { Monitor, Plus, Smartphone } from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { deviceDetail, listedDevices } from "@/lib/account";
import { useMe } from "@/session/me";

export default function Devices() {
  const platform = usePlatform();
  const own = useMe().device?.deviceId ?? null;

  const devices = useAllPages(platform.core.devices.registry.list, (paginationOpts) => ({
    paginationOpts,
  }));

  if (devices.status === "failed") {
    return (
      <Screen readable header={<NavHeader title="Devices" fallback="/you" />}>
        <CalmState
          title="Couldn’t Load Devices"
          description={devices.message}
          actions={<Button label="Try Again" onPress={devices.retry} />}
        />
      </Screen>
    );
  }

  return (
    <Screen readable scroll header={<NavHeader title="Devices" fallback="/you" />}>
      {devices.status === "loading" ? (
        <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
      ) : (
        <>
          {listedDevices(devices.rows, own).map((device) => (
            <ListRow
              key={device.deviceId}
              icon={device.deviceId === own ? Smartphone : Monitor}
              title={device.name}
              detail={deviceDetail(device, own)}
              {...(device.deviceId === own
                ? {}
                : {
                    onPress: () =>
                      router.push({
                        pathname: "/devices/sign-out",
                        params: { deviceId: device.deviceId, name: device.name },
                      }),
                  })}
            />
          ))}
          {devices.next.kind === "loading" || devices.next.kind === "more" ? (
            <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
          ) : null}
          {devices.next.kind === "failed" ? (
            <Button label="Try Again" variant="plain" onPress={devices.next.retry} />
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

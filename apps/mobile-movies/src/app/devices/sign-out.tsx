import { usePlatform } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";

import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { asDeviceId } from "@/lib/account";

export default function RemoveDevice() {
  const params = useLocalSearchParams<{ deviceId: string; name?: string }>();
  const platform = usePlatform();
  const name = params.name ?? "this device";

  return (
    <ConfirmSheet
      title={`Remove ${name}?`}
      description="It is forgotten and everyone on it is signed out."
      action="Remove Device"
      onConfirm={async () => {
        await platform.core.devices.registry.remove({ deviceId: asDeviceId(params.deviceId) });
      }}
    />
  );
}

import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Camera } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { scannedUserCode } from "@/lib/device-code";

const enterCode = () => (router.canGoBack() ? router.back() : router.replace("/approve-device"));

export default function ScanDeviceCode() {
  const [permission, requestPermission] = useCameraPermissions();
  const [unreadable, setUnreadable] = useState(false);
  const scanned = useRef(false);

  useEffect(() => {
    if (permission !== null && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  const onScan = (data: string) => {
    if (scanned.current) return;
    const userCode = scannedUserCode(data);

    if (userCode === null) {
      setUnreadable(true);

      return;
    }

    scanned.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace({ pathname: "/approve-device/[userCode]", params: { userCode } });
  };

  const header = <NavHeader title="Scan Device Code" fallback="/approve-device" />;

  if (permission !== null && !permission.granted && !permission.canAskAgain) {
    return (
      <Screen readable header={header}>
        <CalmState
          placement="top"
          icon={Camera}
          title="Camera access is off"
          description="Allow the camera in Settings to scan a device’s code."
          actions={
            <>
              <Button label="Open Settings" onPress={() => void Linking.openSettings()} />
              <Button label="Enter Code Instead" variant="secondary" onPress={enterCode} />
            </>
          }
        />
      </Screen>
    );
  }

  return (
    <Screen readable scroll header={header}>
      <View className="h-12" />
      <View
        className="h-75 items-center justify-center overflow-hidden rounded-card bg-surface"
        accessible
        accessibilityLabel="Camera viewfinder. Point it at the QR code on your other device."
      >
        {permission?.granted === true ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => onScan(data)}
          />
        ) : null}
        <View className="size-55 justify-center rounded-card border-2 border-dark-text">
          <View className="h-px bg-accent" />
        </View>
      </View>
      {unreadable ? (
        <Text variant="meta" tone="danger" accessibilityLiveRegion="polite">
          That QR code isn’t a device sign-in code.
        </Text>
      ) : null}
      <Button label="Enter Code Instead" variant="secondary" onPress={enterCode} />
    </Screen>
  );
}

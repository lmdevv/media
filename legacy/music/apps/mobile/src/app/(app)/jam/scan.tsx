/**
 * Scans a host's Jam QR code (D12) with the camera and opens its invite (D05). Without camera
 * access it asks for it, or, once refused, points to Settings and back to typing the code.
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import type { BarcodeScanningResult } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Camera, CameraOff } from "lucide-react-native";
import { useRef, useState } from "react";
import { Linking, View } from "react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Page } from "@/components/ui/page";
import { Text } from "@/components/ui/text";
import { jamCodeFrom } from "@/lib/jam";
import { useConnection } from "@/session/connection";

const TITLE = "Scan a QR code";

const typeInstead = (
  <Button label="Enter a code instead" variant="secondary" onPress={() => router.back()} />
);

/** The camera, reading QR codes until one is a Jam link for this server. */
function Scanner() {
  const { origin } = useConnection();
  const [failure, setFailure] = useState<string | null>(null);
  // The camera reports the same code many times a second; only the first good one opens.
  const opened = useRef(false);

  const scanned = ({ data }: BarcodeScanningResult) => {
    if (opened.current) return;
    const input = jamCodeFrom(data, origin);

    if (!input.ok) {
      setFailure(input.reason);

      return;
    }

    opened.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace({ pathname: "/jam/[code]", params: { code: input.code } });
  };

  return (
    <Page title={TITLE} bottom="plain">
      <View className="aspect-square w-full overflow-hidden rounded-mobile-card bg-surface">
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={scanned}
          accessibilityLabel="Camera"
        />
      </View>
      <Text tone={failure === null ? "muted" : "danger"} className="pt-4 pb-6 text-center">
        {failure ?? "Point the camera at the QR code on the host’s screen."}
      </Text>
      {typeInstead}
    </Page>
  );
}

export default function ScanJamCode() {
  const [permission, requestPermission] = useCameraPermissions();

  if (permission === null) {
    return (
      <Page title={TITLE} bottom="plain">
        {null}
      </Page>
    );
  }

  if (permission.granted) return <Scanner />;

  if (permission.canAskAgain) {
    return (
      <Page title={TITLE} bottom="plain">
        <EmptyState
          icon={Camera}
          title={"Scan the\nhost’s code."}
          body={"[music] uses the camera to read it.\nNothing is recorded."}
          primary={<Button label="Allow camera" onPress={() => void requestPermission()} />}
          secondary={typeInstead}
        />
      </Page>
    );
  }

  return (
    <Page title={TITLE} bottom="plain">
      <EmptyState
        icon={CameraOff}
        title={"Camera access\nis off."}
        body={"Turn it on in Settings,\nor type the code instead."}
        primary={<Button label="Open Settings" onPress={() => void Linking.openSettings()} />}
        secondary={typeInstead}
      />
    </Page>
  );
}

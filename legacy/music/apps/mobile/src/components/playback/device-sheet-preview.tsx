/**
 * Play on's in-between states for the components gallery: a move in progress (B06) and a failed
 * one (B07). On a live server a move lands in well under a second, so these are hard to catch
 * otherwise. Sample devices, drawn by the same body as the real sheet.
 */
import { DeviceId } from "@music/commands/ids";
import { View } from "react-native";

import { Text } from "@/components/ui/text";
import type { DeviceRow } from "@/lib/device-sheet";

import { DeviceSheetBody } from "./device-sheet";

const PHONE: DeviceRow = {
  id: DeviceId.make("preview-phone"),
  name: "This iPhone",
  kind: "phone",
  status: "Playing now",
  current: true,
  thisPhone: true,
};

const MAC: DeviceRow = {
  id: DeviceId.make("preview-mac"),
  name: "MacBook",
  kind: "web",
  status: "Online",
  current: false,
  thisPhone: false,
};

const NOTHING = { moveTo: () => {}, close: () => {}, stay: () => {} };

/** B06 and B07 one under the other, each on its sheet surface. */
export function DeviceSheetPreview() {
  return (
    <View className="bleed-page">
      <View className="mt-6 border-t border-border bg-bg">
        <DeviceSheetBody
          sheet={{ kind: "connecting", from: PHONE, to: MAC }}
          actions={NOTHING}
          moving={
            <Text variant="callout" tone="muted" className="pb-4">
              Unfinished Sympathy · 2:18
            </Text>
          }
        />
      </View>
      <View className="mt-6 border-t border-border bg-bg">
        <DeviceSheetBody
          sheet={{
            kind: "failed",
            from: PHONE,
            to: MAC,
            message: "That device didn't respond. Check that it's online and try again.",
          }}
          actions={NOTHING}
          moving={null}
        />
      </View>
    </View>
  );
}

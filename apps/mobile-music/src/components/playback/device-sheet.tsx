import type { DeviceKind } from "@media/player/connect-devices";
import { router } from "expo-router";
import type { LucideIcon } from "lucide-react-native";
import { Airplay, ArrowRight, Smartphone } from "lucide-react-native";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Row, RowCheck, RowChevron } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { Text } from "@/components/ui/text";
import { deviceSheet } from "@/lib/device-sheet";
import type { DeviceRow, DeviceSheet as DeviceSheetState } from "@/lib/device-sheet";
import { clock } from "@/lib/playback-format";
import { useThemeColor } from "@/lib/theme-color";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { useDevices, useNowPlaying, usePlaybackPosition } from "@/player";

/** Old music's glyphs: a phone for the phone app and phone browsers, AirPlay for a computer's. */
export const KIND_ICONS = {
  phone: Smartphone,
  web: Airplay,
} as const satisfies Record<DeviceKind, LucideIcon>;

/** The song that moves and where it stands, or the queue when nothing is current. */
function MovingSubtitle() {
  const { nowPlaying } = useNowPlaying();
  const { positionMs } = usePlaybackPosition();

  return (
    <Text variant="callout" tone="muted" className="pb-4" numberOfLines={1}>
      {nowPlaying === null ? "Your queue" : `${nowPlaying.title} · ${clock(positionMs)}`}
    </Text>
  );
}

function DeviceOption({ row, onPick }: { readonly row: DeviceRow; readonly onPick: () => void }) {
  return (
    <Row
      title={row.name}
      subtitle={row.status}
      active={row.current}
      leading={{ kind: "icon", icon: KIND_ICONS[row.kind] }}
      trailing={row.current ? <RowCheck /> : <RowChevron />}
      onPress={onPick}
    />
  );
}

/** What the sheet's buttons do. */
export interface DeviceSheetActions {
  /** Moves the music to a device, here included. */
  readonly moveTo: (row: DeviceRow) => void;
  /** Closes the sheet. */
  readonly close: () => void;
  /** Keeps the music where it is after a failed move, and closes the sheet. */
  readonly stay: () => void;
}

/**
 * One state of the sheet, drawn from `sheet` alone, so every state can be shown without a move
 * in progress (the components gallery does). `moving` is the song and its place.
 */
export function DeviceSheetBody({
  sheet,
  actions,
  moving,
}: {
  readonly sheet: DeviceSheetState;
  readonly actions: DeviceSheetActions;
  readonly moving: ReactNode;
}) {
  const muted = useThemeColor("--color-text-muted");
  const { moveTo, close, stay } = actions;

  if (sheet.kind === "connecting") {
    const { from, to } = sheet;

    return (
      <SheetLayout title={`Moving to ${to.name}`}>
        {moving}
        <Row
          title={from.name}
          subtitle="Sending your position…"
          leading={{ kind: "icon", icon: KIND_ICONS[from.kind] }}
          trailing={<Icon icon={ArrowRight} size="inline" />}
        />
        <Row
          title={to.name}
          subtitle="Connecting…"
          leading={{ kind: "icon", icon: KIND_ICONS[to.kind] }}
          trailing={<ActivityIndicator color={muted} accessibilityLabel="Connecting" />}
        />
      </SheetLayout>
    );
  }

  if (sheet.kind === "failed") {
    const { from, to, message } = sheet;

    return (
      <SheetLayout
        title={`Couldn’t reach ${to.name}`}
        subtitle={`Your music is still on ${from.thisPhone ? `this ${DEVICE_FAMILY}` : from.name}.`}
      >
        <Text variant="callout" tone="muted">
          {message}
        </Text>
        <View className="flex-row gap-3 pt-mobile-edge">
          <Button
            label="Try again"
            className="flex-1"
            onPress={() => {
              moveTo(to);
            }}
          />
          <Button label="Stay here" variant="secondary" className="flex-1" onPress={stay} />
        </View>
      </SheetLayout>
    );
  }

  if (sheet.kind === "only") {
    return (
      <SheetLayout
        title="Play on"
        actions={<Button label="Done" variant="secondary" onPress={close} />}
      >
        {moving}
        <DeviceOption row={sheet.row} onPick={close} />
        <Text variant="callout" tone="muted" className="pt-4">
          No other devices right now
        </Text>
      </SheetLayout>
    );
  }

  return (
    <SheetLayout title="Play on">
      {moving}
      {sheet.rows.map((row) => (
        <DeviceOption
          key={row.target}
          row={row}
          onPick={() => {
            if (row.current) close();
            else moveTo(row);
          }}
        />
      ))}
    </SheetLayout>
  );
}

/** The Play on sheet for the person's devices and the move in progress. */
export function DeviceSheet() {
  const { devices, active, transfer, moveTo, dismissTransfer } = useDevices();
  const sheet = deviceSheet({ family: DEVICE_FAMILY, devices, active, transfer });
  const previous = useRef(transfer.state);

  // A move that lands closes the sheet, as old music's did.
  useEffect(() => {
    if (previous.current === "pending" && transfer.state === "idle") router.back();
    previous.current = transfer.state;
  }, [transfer.state]);

  // A failure shows until the sheet closes, however it closes, and a move the person closed the
  // sheet on goes on without it: neither comes back when the sheet opens again.
  useEffect(() => dismissTransfer, [dismissTransfer]);

  return (
    <DeviceSheetBody
      sheet={sheet}
      moving={<MovingSubtitle />}
      actions={{
        moveTo: (row) => {
          moveTo(row.target);
        },
        close: () => {
          router.back();
        },
        stay: () => {
          dismissTransfer();
          router.back();
        },
      }}
    />
  );
}

/**
 * Play on (B05 to B08, H07): where the music plays, and moving it to another of the person's
 * devices. One sheet shows every state of a move: the list, the move in progress with the playing
 * device still shown, and a failed move, which leaves the music where it was. A move that lands
 * closes the sheet, and Now Playing then says where the music plays (B02).
 */
import type { DeviceKind } from "@music/commands/models";
import { router } from "expo-router";
import type { LucideIcon } from "lucide-react-native";
import { Airplay, ArrowRight, Music, Smartphone, SquareTerminal } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/ui/notice";
import { Row, RowCheck, RowChevron } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { Text } from "@/components/ui/text";
import { deviceSheet } from "@/lib/device-sheet";
import type { DeviceRow, DeviceSheet as DeviceSheetState } from "@/lib/device-sheet";
import { clock } from "@/lib/playback-format";
import { useThemeColor } from "@/lib/theme-color";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { useDevices, useNowPlaying, usePlaybackPosition, usePlayerActions } from "@/player";

const KIND_ICONS = {
  phone: Smartphone,
  web: Airplay,
  cli: SquareTerminal,
} as const satisfies Record<DeviceKind, LucideIcon>;

/** Moves the music to `row`'s device: this phone through `playHere`, which also wakes its audio. */
const useMoveTo = () => {
  const { transferTo, playHere } = usePlayerActions();

  return (row: DeviceRow) => {
    void (row.thisPhone ? playHere() : transferTo(row.id));
  };
};

/** B06's subtitle: the song and where it is, the only part that follows the position. */
function MovingSubtitle() {
  const { nowPlaying } = useNowPlaying();
  const { positionMs } = usePlaybackPosition();

  return (
    <Text variant="callout" tone="muted" className="pb-4" numberOfLines={1}>
      {nowPlaying === null ? "Your queue" : `${nowPlaying.title} · ${clock(positionMs)}`}
    </Text>
  );
}

/** A device to pick: the current one in the accent with a check, the others with a chevron. */
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
  /** Moves the music to a device, or back to where it was. */
  readonly moveTo: (row: DeviceRow) => void;
  /** Closes the sheet. */
  readonly close: () => void;
  /** Keeps the music where it is after a failed move, and closes the sheet. */
  readonly stay: () => void;
}

/**
 * One state of the sheet, drawn from `sheet` alone, so every state can be shown without a move
 * in progress (the components gallery does). `moving` is B06's subtitle.
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
      <SheetLayout
        title={`Moving to ${to.name}`}
        actions={
          <Button
            label="Cancel transfer"
            variant="secondary"
            onPress={() => {
              moveTo(from);
            }}
          />
        }
      >
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
        <Notice icon={Music} title="Keep listening" body="Your queue and volume stay in sync." />
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
        <Notice icon={Airplay} title={`Open [music] on ${to.name}`} body={message} />
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
        <DeviceOption row={sheet.row} onPick={close} />
        <Notice
          icon={Airplay}
          title="Your other devices will appear here"
          body="Open [music] on another device and sign in to the same server."
        />
      </SheetLayout>
    );
  }

  return (
    <SheetLayout title="Play on" subtitle="Move the music and keep your place.">
      {sheet.rows.map((row) => (
        <DeviceOption
          key={row.id}
          row={row}
          onPick={() => {
            if (row.current) close();
            else moveTo(row);
          }}
        />
      ))}
      <Notice
        icon={Airplay}
        title="One queue, every device"
        body={`Selecting a device moves playback there. This ${DEVICE_FAMILY} can keep controlling it.`}
      />
    </SheetLayout>
  );
}

/** The Play on sheet for the devices and the move in progress. */
export function DeviceSheet() {
  const { thisDevice, devices, transfer, dismissTransfer } = useDevices();
  const moveTo = useMoveTo();
  const [now] = useState(Date.now);

  const sheet = deviceSheet({
    thisDevice,
    family: DEVICE_FAMILY,
    devices,
    transfer,
    now,
  });

  // A move that lands closes the sheet; one that fails stays to say so.
  const previous = useRef(transfer.state);

  useEffect(() => {
    if (previous.current === "pending" && transfer.state === "idle") router.back();
    previous.current = transfer.state;
  }, [transfer.state]);

  // Closing a failed move's sheet keeps the music here, as "Stay here" does.
  const failed = useRef(false);

  useEffect(() => {
    failed.current = sheet.kind === "failed";
  }, [sheet.kind]);

  useEffect(
    () => () => {
      if (failed.current) dismissTransfer();
    },
    [dismissTransfer],
  );

  return (
    <DeviceSheetBody
      sheet={sheet}
      moving={<MovingSubtitle />}
      actions={{
        moveTo,
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

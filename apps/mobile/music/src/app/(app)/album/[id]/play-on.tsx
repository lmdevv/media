import { deviceKind } from "@media/player/connect-devices";
import { Option, Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator } from "react-native";

import { KIND_ICONS } from "@/components/playback/device-sheet";
import { Row, RowChevron } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { Text } from "@/components/ui/text";
import { useAlbumDetail } from "@/lib/details";
import { AlbumId } from "@/lib/ids";
import type { AlbumDetail } from "@/lib/models";
import { useThemeColor } from "@/lib/theme-color";
import { useDevices } from "@/player";

const decodeId = Schema.decodeUnknownOption(AlbumId);

const FAILED = "Couldn’t play it there. Try again.";

/**
 * Plays the album on another of the person's devices, which takes playback over (ADR 0018).
 */
function Sheet({ detail }: { readonly detail: AlbumDetail }) {
  const { devices, active, playOn } = useDevices();
  const muted = useThemeColor("--color-text-muted");
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { album } = detail;

  const play = async (deviceId: string) => {
    setFailure(null);
    setPending(deviceId);

    const played = await playOn(deviceId, {
      domain: "music",
      ref: { type: "album", id: album.id },
    });

    setPending(null);

    if (played) router.back();
    else setFailure(FAILED);
  };

  return (
    <SheetLayout title="Play on" subtitle={album.title}>
      {devices.map((device) => (
        <Row
          key={device.id}
          title={device.name}
          subtitle={device.id === active ? "Playing now" : "Online"}
          leading={{ kind: "icon", icon: KIND_ICONS[deviceKind(device.name)] }}
          trailing={
            pending === device.id ? (
              <ActivityIndicator color={muted} accessibilityLabel="Starting" />
            ) : (
              <RowChevron />
            )
          }
          onPress={pending === null ? () => void play(device.id) : undefined}
        />
      ))}
      {devices.length === 0 ? (
        <Text variant="callout" tone="muted">
          No other devices right now
        </Text>
      ) : null}
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-3">
          {failure}
        </Text>
      )}
    </SheetLayout>
  );
}

export default function AlbumPlayOn() {
  const albumId = Option.getOrNull(decodeId(useLocalSearchParams().id));
  const detail = useAlbumDetail(albumId ?? "skip");

  if (albumId === null || detail instanceof Error) {
    return (
      <SheetLayout title="Play on" subtitle="This album couldn’t be opened. Close and try again." />
    );
  }

  return detail === undefined ? null : <Sheet detail={detail} />;
}

import { useEffect, useRef, useState } from "react";
import { PanResponder, View } from "react-native";
import type { GestureResponderEvent, HostInstance } from "react-native";

import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { formatClock, formatTimeLeft } from "@/lib/player/clock";
import type { ScrubTile } from "@/lib/player/scrubbing";

const PREVIEW_WIDTH = 184;

/** Props for `Scrubber`. */
export interface ScrubberProps {
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly tileAt: (seconds: number) => ScrubTile | null;
  /** Called as a drag starts and ends, so the controls stay up meanwhile. */
  readonly onScrubbing: (scrubbing: boolean) => void;
  readonly onSeek: (seconds: number) => void;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

function Thumbnail({ tile }: { readonly tile: ScrubTile }) {
  const scale = PREVIEW_WIDTH / tile.width;

  return (
    <View className="h-26 w-46 overflow-hidden rounded-control bg-dark-surface">
      <Image
        source={{ uri: tile.url }}
        contentFit="fill"
        cachePolicy="memory-disk"
        transition={0}
        style={{
          position: "absolute",
          width: tile.sheetWidth * scale,
          height: tile.sheetHeight * scale,
          left: -tile.x * scale,
          top: -tile.y * scale,
        }}
      />
    </View>
  );
}

/** The player's position and the way to move it. */
export function Scrubber({
  positionSeconds,
  durationSeconds,
  tileAt,
  onScrubbing,
  onSeek,
}: ScrubberProps) {
  const track = useRef<HostInstance>(null);
  const bounds = useRef({ left: 0, width: 1 });
  const [scrub, setScrub] = useState<number | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const latest = useRef({ durationSeconds, onScrubbing, onSeek });

  useEffect(() => {
    latest.current = { durationSeconds, onScrubbing, onSeek };
  }, [durationSeconds, onScrubbing, onSeek]);

  const [responder] = useState(() => {
    const fractionOf = (event: GestureResponderEvent): number =>
      clamp((event.nativeEvent.pageX - bounds.current.left) / bounds.current.width);

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        latest.current.onScrubbing(true);
        setScrub(fractionOf(event));
      },
      onPanResponderMove: (event) => {
        setScrub(fractionOf(event));
      },
      onPanResponderRelease: (event) => {
        const fraction = fractionOf(event);

        setScrub(null);
        latest.current.onScrubbing(false);
        latest.current.onSeek(fraction * latest.current.durationSeconds);
      },
      onPanResponderTerminate: () => {
        setScrub(null);
        latest.current.onScrubbing(false);
      },
      onPanResponderTerminationRequest: () => false,
    });
  });

  const duration = Math.max(0, durationSeconds);
  const shownSeconds = scrub === null ? positionSeconds : scrub * duration;
  const fraction = duration > 0 ? clamp(shownSeconds / duration) : 0;
  const tile = scrub === null ? null : tileAt(shownSeconds);

  return (
    <View className="flex-row items-center gap-4">
      <Text variant="monoMedium" tone="onMedia">
        {formatClock(positionSeconds)}
      </Text>
      <View
        className="h-11 flex-1 justify-center"
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Playback position"
        accessibilityValue={{ text: `${formatClock(shownSeconds)} of ${formatClock(duration)}` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => {
          onSeek(positionSeconds + (event.nativeEvent.actionName === "increment" ? 10 : -10));
        }}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        {...responder.panHandlers}
      >
        <View
          ref={track}
          onLayout={() => {
            track.current?.measureInWindow((x, _y, width) => {
              bounds.current = { left: x, width: Math.max(1, width) };
            });
          }}
          className="h-1 w-full overflow-hidden rounded-pill bg-dark-hairline"
        >
          <View
            className="h-full rounded-pill bg-accent"
            style={{ width: `${String(fraction * 100)}%` }}
          />
        </View>
        {scrub === null ? null : (
          <View
            pointerEvents="none"
            className="absolute bottom-full w-46 items-center gap-2 pb-2"
            style={{
              left: Math.min(
                Math.max(0, fraction * trackWidth - PREVIEW_WIDTH / 2),
                Math.max(0, trackWidth - PREVIEW_WIDTH),
              ),
            }}
          >
            {tile === null ? null : <Thumbnail tile={tile} />}
            <Text variant="labelStrong" tone="onMedia">
              {formatClock(shownSeconds)}
            </Text>
          </View>
        )}
      </View>
      <Text variant="monoMedium" tone="onMedia">
        {formatTimeLeft(positionSeconds, duration)}
      </Text>
    </View>
  );
}

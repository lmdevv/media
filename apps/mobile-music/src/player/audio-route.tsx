/**
 * AirPlay for the music app (ADR 0018): the system's route picker, and where the app's sound goes,
 * from the app's `AudioRoute` module (`modules/audio-route`). The phone reports an AirPlay route as
 * its Connect output, so the person's other devices show the receiver on its row.
 */
import type { ConnectOutput } from "@media/player/connect-player";
import { requireNativeModule, requireNativeView } from "expo";
import type { EventEmitter } from "expo";
import { useEffect, useState } from "react";
import type { ViewProps } from "react-native";

import { useThemeColor, useThemeLength } from "@/lib/theme-color";

/**
 * The route as the module answers it (`AudioRouteModule.swift`): an AirPlay receiver by its name,
 * null when it shows none, or the phone itself.
 */
type NativeOutput =
  | { readonly kind: "local" }
  | { readonly kind: "airplay"; readonly receiver: string | null };

/** The events of the `AudioRoute` module. A type, so it fits expo's `EventEmitter`. */
type AudioRouteEvents = {
  /** The route changed: the new route, as `output` answers it. */
  readonly outputChanged: (output: NativeOutput) => void;
};

/** The `AudioRoute` module. */
type AudioRoute = EventEmitter<AudioRouteEvents> & { readonly output: () => NativeOutput };

const LOCAL: ConnectOutput = { kind: "local" };

/** `answer` as Connect names it. */
const outputOf = (answer: NativeOutput): ConnectOutput =>
  answer.kind === "local" ? LOCAL : { kind: "airplay", receiver: answer.receiver };

/**
 * Where the app's sound goes now, following each change of route: an AirPlay receiver, or the
 * phone itself.
 */
export const useAudioOutput = (): ConnectOutput => {
  const [route] = useState(() => requireNativeModule<AudioRoute>("AudioRoute"));
  const [output, setOutput] = useState(() => outputOf(route.output()));

  useEffect(() => {
    const follow = (answer: NativeOutput): void => {
      setOutput(outputOf(answer));
    };

    const subscription = route.addListener("outputChanged", follow);

    // A change between the first read and the listener counts too.
    follow(route.output());

    return () => {
      subscription.remove();
    };
  }, [route]);

  return output;
};

interface NativePickerProps extends ViewProps {
  readonly tint: string;
  readonly activeTint: string;
  readonly onBeginPresentingRoutes?: () => void;
  readonly onEndPresentingRoutes?: () => void;
}

const NativeRoutePicker = requireNativeView<NativePickerProps>("AudioRoute");

/**
 * The system's AirPlay route picker as a 44-point button: tapping it opens the picker, and the
 * music plays where it was until the person chooses a route there.
 */
export function AirPlayButton() {
  const tint = useThemeColor("--color-text");
  const accent = useThemeColor("--color-accent");
  const size = useThemeLength("--spacing-hit-target");

  return (
    <NativeRoutePicker
      accessibilityLabel="AirPlay"
      accessibilityHint="Chooses a speaker or TV to play on"
      style={{ width: size, height: size }}
      tint={tint}
      activeTint={accent}
    />
  );
}

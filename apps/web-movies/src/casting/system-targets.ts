/**
 * Playing on other screens through the browser itself: AirPlay in Safari and the standard Remote
 * Playback API elsewhere (Chrome on Android casts through it). Both play the `<video>` element's
 * own source on the device, so the element keeps firing its events and progress reporting carries
 * on unchanged. AirPlay needs the element to play HLS natively, which Safari does here (hls.js is
 * never used in Safari), and `x-webkit-airplay="allow"` on the element. Remote Playback cannot
 * send Media Source streams (hls.js), so it reports itself unavailable for them.
 */
import { useCallback, useEffect, useState } from "react";

/** A way to play on another screen through the browser. */
export interface SystemTarget {
  /** A device is around. */
  readonly available: boolean;
  /** The video plays on a device now. */
  readonly active: boolean;
  /** Opens the browser's device picker. */
  readonly choose: () => void;
}

const AVAILABILITY = "webkitplaybacktargetavailabilitychanged";

const WIRELESS = "webkitcurrentplaybacktargetiswirelesschanged";

/** AirPlay for `video`, or null where the browser has no AirPlay picker. */
export const useAirPlay = (video: HTMLVideoElement | null): SystemTarget | null => {
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);
  const supported = video?.webkitShowPlaybackTargetPicker !== undefined;

  useEffect(() => {
    if (video === null || !supported) return undefined;

    const onAvailability = (event: Event): void => {
      setAvailable("availability" in event && event.availability === "available");
    };

    const onWireless = (): void => setActive(video.webkitCurrentPlaybackTargetIsWireless === true);

    video.addEventListener(AVAILABILITY, onAvailability);
    video.addEventListener(WIRELESS, onWireless);

    return () => {
      video.removeEventListener(AVAILABILITY, onAvailability);
      video.removeEventListener(WIRELESS, onWireless);
    };
  }, [video, supported]);

  const choose = useCallback(() => video?.webkitShowPlaybackTargetPicker?.(), [video]);

  return supported ? { available: available || active, active, choose } : null;
};

/** The Remote Playback API for `video`, or null where the browser lacks it. */
export const useRemotePlayback = (video: HTMLVideoElement | null): SystemTarget | null => {
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);
  const remote = video === null || !("remote" in video) ? null : video.remote;

  useEffect(() => {
    if (remote === null) return undefined;

    let watch: number | null = null;
    let disposed = false;
    const onState = (): void => setActive(remote.state !== "disconnected");

    const onAvailability = (found: boolean): void => {
      if (!disposed) setAvailable(found);
    };

    // Rejects for sources it cannot send (Media Source streams) and where it is turned off.
    remote.watchAvailability(onAvailability).then(
      (id) => {
        if (disposed) void remote.cancelWatchAvailability(id).catch(() => undefined);
        else watch = id;

        return id;
      },
      () => onAvailability(false),
    );

    remote.addEventListener("connecting", onState);
    remote.addEventListener("connect", onState);
    remote.addEventListener("disconnect", onState);

    return () => {
      disposed = true;

      if (watch !== null) void remote.cancelWatchAvailability(watch).catch(() => undefined);

      remote.removeEventListener("connecting", onState);
      remote.removeEventListener("connect", onState);
      remote.removeEventListener("disconnect", onState);
    };
  }, [remote]);

  const choose = useCallback(() => {
    void remote?.prompt().catch(() => undefined);
  }, [remote]);

  return remote === null ? null : { available: available || active, active, choose };
};

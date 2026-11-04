import { estimateClockOffset } from "@media/contracts/clock";
import type { RoomId } from "@media/contracts/ids";
import { useCommand } from "@media/sdk/react";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { deviceId } from "@/lib/device";
import { describeFailure } from "@/lib/failure";
import { useActiveProfile } from "@/session/active-profile";

/** Goes back, or home when the screen opened first, such as from a link. */
export const goBack = (): void => {
  if (router.canGoBack()) router.back();
  else router.replace("/");
};

/** Copying a link: whether it was copied, and why it could not be. */
export const useCopyLink = () => {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = useCallback((link: string) => {
    setError(null);
    Clipboard.setStringAsync(link).then(
      () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setCopied(true);

        return undefined;
      },
      () => {
        setCopied(false);
        setError("Couldn’t copy the link.");
      },
    );
  }, []);

  const reset = useCallback(() => {
    setCopied(false);
    setError(null);
  }, []);

  return { copied, error, copy, reset };
};

/**
 * Joining `roomId` on this device with the active profile: `join` resolves true once joined, or
 * false with the reason in `error`.
 */
export const useJoinRoom = (roomId: RoomId | null) => {
  const { profile } = useActiveProfile();
  const joinRoom = useCommand("rooms.join");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = useCallback(async (): Promise<boolean> => {
    if (roomId === null) return false;
    setBusy(true);
    setError(null);

    try {
      await joinRoom({ roomId, profileId: profile.id, deviceId: deviceId() });

      return true;
    } catch (cause) {
      setError(describeFailure(cause));

      return false;
    } finally {
      setBusy(false);
    }
  }, [roomId, profile.id, joinRoom]);

  return { busy, error, join };
};

interface RoomClockRead {
  readonly roomId: RoomId;
  readonly offsetMs: number;
}

/**
 * This device's clock offset from the server's, read once per room: `read` turns true once the
 * server answered or could not, when the device's own clock stands in (offset 0).
 */
export const useServerClock = (
  roomId: RoomId | null,
): { readonly read: boolean; readonly offsetMs: number } => {
  const readTime = useCommand("rooms.time");
  const [clock, setClock] = useState<RoomClockRead | null>(null);

  useEffect(() => {
    if (roomId === null) return undefined;

    let active = true;
    const sentAt = Date.now();

    readTime({}).then(
      ({ serverTime }) => {
        const offset = estimateClockOffset([{ sentAt, serverTime, receivedAt: Date.now() }]);

        if (active) setClock({ roomId, offsetMs: offset?.offsetMs ?? 0 });

        return undefined;
      },
      () => {
        if (active) setClock({ roomId, offsetMs: 0 });
      },
    );

    return () => {
      active = false;
    };
  }, [roomId, readTime]);

  return clock !== null && clock.roomId === roomId
    ? { read: true, offsetMs: clock.offsetMs }
    : { read: false, offsetMs: 0 };
};

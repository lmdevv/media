import type { Profile } from "@media/contracts/models/profiles";
import { useCommand } from "@media/sdk/react";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { PinDots, PinPad } from "@/components/pin-pad";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { describeFailure } from "@/lib/failure";
import { lockoutLine, wrongPinLine } from "@/lib/pin";

/** Props for `UnlockProfile`. */
export interface UnlockProfileProps {
  readonly profile: Profile;
  /**
   * Called once the server accepted the PIN; the profile is unlocked on this session. Screens
   * that only wait for the profile list to show it unlocked leave it out.
   */
  readonly onUnlocked?: () => void;
  /** B07's way out: choose another profile. */
  readonly onSwitchProfile: () => void;
}

type Entry =
  | { readonly kind: "entry"; readonly message: string | null }
  | { readonly kind: "lockedOut"; readonly retryAt: number };

const TICK_MS = 15_000;

const useNow = (active: boolean): number => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);

    return () => clearInterval(timer);
  }, [active]);

  return now;
};

/** Asks for `profile`'s PIN and unlocks it. */
export function UnlockProfile({ profile, onUnlocked, onSwitchProfile }: UnlockProfileProps) {
  const unlock = useCommand("profiles.unlock");
  const [pin, setPin] = useState("");
  const [entry, setEntry] = useState<Entry>({ kind: "entry", message: null });
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);
  const now = useNow(entry.kind === "lockedOut");
  const lockedOut = entry.kind === "lockedOut" && entry.retryAt > now;

  const submit = async (value: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);

    try {
      const result = await unlock({ profileId: profile.id, pin: value });

      if (result.status === "unlocked") {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onUnlocked?.();

        return;
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setEntry(
        result.status === "wrong_pin"
          ? { kind: "entry", message: wrongPinLine(result.attemptsLeft) }
          : { kind: "lockedOut", retryAt: result.retryAt },
      );
    } catch (cause) {
      setEntry({ kind: "entry", message: describeFailure(cause) });
    } finally {
      inFlight.current = false;
      setChecking(false);
      setPin("");
    }
  };

  return (
    <Screen readable header={<NavHeader title={lockedOut ? "Profile Locked" : "Enter PIN"} />}>
      <View className="gap-4 px-5 py-4 regular:flex-1 regular:justify-center regular:px-0 regular:pb-24">
        <View className="h-12 regular:hidden" />
        <View className="items-center gap-4">
          <ProfileAvatar profile={profile} size="row" />
          <Text variant="subheading">{profile.name}</Text>
        </View>
        {entry.kind === "lockedOut" && lockedOut ? (
          <>
            <PinDots filled={0} wrong={false} label={`${profile.name}'s PIN`} />
            <Text variant="secondary" tone="muted" className="text-center">
              {lockoutLine(entry.retryAt, now)}
            </Text>
            <Button label="Switch Profile" variant="secondary" onPress={onSwitchProfile} />
          </>
        ) : (
          <PinPad
            value={pin}
            onChange={(next) => {
              setPin(next);

              if (entry.kind === "entry" && entry.message !== null) {
                setEntry({ kind: "entry", message: null });
              }
            }}
            onComplete={(value) => void submit(value)}
            message={
              entry.kind === "entry" && entry.message !== null
                ? { text: entry.message, tone: "danger" }
                : null
            }
            disabled={checking}
            label={`${profile.name}'s PIN`}
          />
        )}
      </View>
    </Screen>
  );
}

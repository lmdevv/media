import type { Profile } from "@media/contracts/models/profiles";
import { useCommand } from "@media/sdk/react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";

import { ProfileEditorProvider } from "@/components/profile-editor";
import { UnlockProfile } from "@/components/unlock-profile";
import { useAccountProfiles } from "@/session/account-profiles";
import { useProfileChoice } from "@/session/profile-choice";

const useLockOnLeave = (profile: Profile | null): void => {
  const lock = useCommand("profiles.lock");
  const { profileId: chosen } = useProfileChoice();
  const profileId = profile?.id ?? null;
  const hasPin = profile?.hasPin ?? false;
  const latest = useRef({ profileId, chosen, hasPin });

  useEffect(() => {
    latest.current = { profileId, chosen, hasPin };
  }, [profileId, chosen, hasPin]);

  useEffect(
    () => () => {
      const { profileId: edited, chosen: inUse, hasPin: guarded } = latest.current;

      if (guarded && edited !== null && edited !== inUse) {
        void lock({ profileId: edited }).catch(() => undefined);
      }
    },
    [lock],
  );
};

function EditorStack({
  profile,
  takenAvatars,
}: {
  readonly profile: Profile | null;
  readonly takenAvatars: ReadonlyArray<string>;
}) {
  return (
    <ProfileEditorProvider profile={profile} takenAvatars={takenAvatars}>
      <Stack screenOptions={{ headerShown: false }} />
    </ProfileEditorProvider>
  );
}

export default function ProfileEditorLayout() {
  const { profileId } = useLocalSearchParams<{ profileId: string }>();
  const profiles = useAccountProfiles();
  const creating = profileId === "new";

  const profile = creating
    ? null
    : (profiles?.find((candidate) => candidate.id === profileId) ?? null);

  useLockOnLeave(profile);

  if (profiles === null || (!creating && profile === null)) return null;

  if (profile?.locked === true) {
    return <UnlockProfile profile={profile} onSwitchProfile={() => router.back()} />;
  }

  return (
    <EditorStack
      key={profile?.id ?? "new"}
      profile={profile}
      takenAvatars={profiles
        .filter((other) => other.id !== profile?.id)
        .map((other) => other.avatar)}
    />
  );
}

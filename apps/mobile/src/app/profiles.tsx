import type { Profile } from "@media/contracts/models/profiles";
import { router } from "expo-router";
import { Lock, Pencil, Plus } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { describeFailure } from "@/lib/failure";
import { canAddProfile } from "@/lib/profile-draft";
import { useProfileChoice } from "@/session/profile-choice";
import { useSessionPhase } from "@/session/session-phase";
import { useSignOut } from "@/session/viewer";

function ProfileTile({
  profile,
  onPress,
}: {
  readonly profile: Profile;
  readonly onPress: () => void;
}) {
  const detail = profile.hasPin ? "PIN" : profile.kids ? "Kids" : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail === null ? profile.name : `${profile.name}, ${detail}`}
      onPress={onPress}
      className="items-center gap-3 active:opacity-70"
    >
      <ProfileAvatar profile={profile} />
      <Text variant="navTitle" numberOfLines={1} className="max-w-28 regular:max-w-36">
        {profile.name}
      </Text>
      {profile.hasPin ? (
        <Icon icon={Lock} tone="muted" size="chevron" />
      ) : profile.kids ? (
        <Text variant="metaStrong" tone="muted">
          Kids
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function Profiles() {
  const phase = useSessionPhase();
  const { choose } = useProfileChoice();
  const signOut = useSignOut();
  const [busy, setBusy] = useState(false);
  const profiles = phase.kind === "chooseProfile" ? phase.profiles : [];

  const pick = (profile: Profile) => {
    if (profile.locked) {
      router.push({ pathname: "/profile-pin/[profileId]", params: { profileId: profile.id } });

      return;
    }

    void choose(profile.id).catch((cause: unknown) => {
      Alert.alert("Couldn’t Switch Profile", describeFailure(cause));
    });
  };

  return (
    <Screen
      readable
      scroll
      header={
        <View className="h-16 flex-row items-center gap-3 regular:hidden">
          <Text variant="largeTitle" accessibilityRole="header" className="flex-1">
            Who’s Watching?
          </Text>
          <IconButton
            icon={Pencil}
            label="Manage Profiles"
            onPress={() => router.push("/manage-profiles")}
          />
        </View>
      }
      contentClassName="regular:items-center regular:justify-center regular:gap-12 regular:pb-8"
    >
      <Text variant="largeTitle" accessibilityRole="header" className="hidden regular:flex">
        Who’s Watching?
      </Text>
      <View className="h-24 regular:hidden" />
      <View className="flex-row flex-wrap justify-center gap-8 regular:gap-10">
        {profiles.map((profile) => (
          <ProfileTile key={profile.id} profile={profile} onPress={() => pick(profile)} />
        ))}
      </View>
      <View className="h-8 regular:hidden" />
      <View className="gap-4">
        <Button
          label="Manage Profiles"
          variant="secondary"
          icon={Pencil}
          onPress={() => router.push("/manage-profiles")}
          className="hidden regular:flex regular:min-w-50"
        />
        {canAddProfile(profiles.length) ? (
          <Button
            label="Add Profile"
            variant="secondary"
            icon={Plus}
            onPress={() =>
              router.push({ pathname: "/profile/[profileId]", params: { profileId: "new" } })
            }
            className="regular:min-w-50"
          />
        ) : null}
        <Button
          label="Sign Out"
          variant="secondary"
          busy={busy}
          onPress={() => {
            setBusy(true);
            void signOut().catch(() => setBusy(false));
          }}
          className="regular:min-w-50"
        />
      </View>
    </Screen>
  );
}

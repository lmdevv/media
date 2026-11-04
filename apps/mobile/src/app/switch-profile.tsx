import type { Profile } from "@media/contracts/models/profiles";
import { router } from "expo-router";
import { Pencil, X } from "lucide-react-native";
import { Alert, Pressable, View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { describeFailure } from "@/lib/failure";
import { useActiveProfile } from "@/session/active-profile";
import { useProfileChoice } from "@/session/profile-choice";

export default function SwitchProfile() {
  const { profile: active, profiles } = useActiveProfile();
  const { choose } = useProfileChoice();

  const pick = (profile: Profile) => {
    router.back();

    if (profile.id === active.id) return;

    if (profile.locked) {
      router.push({ pathname: "/profile-pin/[profileId]", params: { profileId: profile.id } });

      return;
    }

    void choose(profile.id).catch((cause: unknown) => {
      Alert.alert("Couldn’t Switch Profile", describeFailure(cause));
    });
  };

  return (
    <View className="gap-4 bg-surface-raised px-5 pt-6 pb-8 regular:px-6 regular:pb-6">
      <View className="flex-row items-center gap-3">
        <Text variant="heading" className="flex-1" accessibilityRole="header">
          Switch Profile
        </Text>
        <IconButton icon={X} label="Close" onPress={() => router.back()} />
      </View>
      <View className="flex-row flex-wrap gap-5">
        {profiles.map((profile) => (
          <Pressable
            key={profile.id}
            accessibilityRole="button"
            accessibilityLabel={profile.name}
            accessibilityState={{ selected: profile.id === active.id }}
            onPress={() => pick(profile)}
            className="items-center gap-2 active:opacity-70"
          >
            <ProfileAvatar profile={profile} size="sheet" />
            <Text variant="bodyMedium" numberOfLines={1} className="max-w-20">
              {profile.name}
            </Text>
          </Pressable>
        ))}
      </View>
      <ListRow
        icon={Pencil}
        title="Manage Profiles"
        onPress={() => {
          router.back();
          router.push("/manage-profiles");
        }}
      />
    </View>
  );
}

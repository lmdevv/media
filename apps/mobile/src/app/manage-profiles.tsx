import type { Profile } from "@media/contracts/models/profiles";
import { router } from "expo-router";
import { Check, Pencil, Plus } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { canAddProfile } from "@/lib/profile-draft";
import { useAccountProfiles } from "@/session/account-profiles";

const edit = (profileId: string) =>
  router.push({ pathname: "/profile/[profileId]", params: { profileId } });

function ProfileRow({ profile }: { readonly profile: Profile }) {
  return (
    <View className="h-24 flex-row items-center gap-4">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Edit ${profile.name}`}
        onPress={() => edit(profile.id)}
        className="flex-1 flex-row items-center gap-4 active:opacity-70"
      >
        <ProfileAvatar profile={profile} size="row" />
        <Text variant="subheading" numberOfLines={1} className="flex-1">
          {profile.name}
        </Text>
      </Pressable>
      <IconButton
        icon={Pencil}
        label={`Edit ${profile.name}`}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={() => edit(profile.id)}
      />
    </View>
  );
}

export default function ManageProfiles() {
  const profiles = useAccountProfiles() ?? [];

  return (
    <Screen
      readable
      scroll
      header={
        <NavHeader
          title="Manage Profiles"
          trailing={<IconButton icon={Check} label="Done" onPress={() => router.back()} />}
        />
      }
    >
      <View className="h-16" />
      {profiles.map((profile) => (
        <ProfileRow key={profile.id} profile={profile} />
      ))}
      {canAddProfile(profiles.length) ? (
        <Button label="Add Profile" variant="secondary" icon={Plus} onPress={() => edit("new")} />
      ) : null}
    </Screen>
  );
}

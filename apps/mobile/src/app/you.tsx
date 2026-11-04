import { useCommandQuery } from "@media/sdk/react";
import { router } from "expo-router";
import {
  Airplay,
  Bookmark,
  ChevronDown,
  History,
  Server,
  Settings2,
  TvMinimal,
  UserRound,
} from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";

import { mayOpenOwnerSettings } from "@/components/owner/viewer";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { READABLE_COLUMN, Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { plural } from "@/lib/browse";
import { useActiveProfile } from "@/session/active-profile";

export default function You() {
  const { profile } = useActiveProfile();
  const list = useCommandQuery("myList.list", { profileId: profile.id });
  const viewer = useCommandQuery("account.viewer", {});

  const accountSettings = viewer.status === "success" && viewer.data.scopes.includes("account");
  const ownerSettings = viewer.status === "success" && mayOpenOwnerSettings(viewer.data);

  return (
    <Screen
      edges={["top"]}
      header={
        <View className={`h-16 flex-row items-center gap-3 ${READABLE_COLUMN}`}>
          <Text
            variant="largeTitle"
            className="flex-1"
            numberOfLines={1}
            accessibilityRole="header"
          >
            You
          </Text>
          <IconButton
            icon={Settings2}
            label="App Settings"
            onPress={() => router.push("/settings")}
          />
        </View>
      }
    >
      <ScrollView
        contentContainerClassName={`gap-2 px-5 py-4 ${READABLE_COLUMN}`}
        contentInsetAdjustmentBehavior="never"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${profile.name}, Switch Profile`}
          onPress={() => router.push("/switch-profile")}
          className="flex-row items-center gap-4 py-3 active:opacity-70"
        >
          <ProfileAvatar profile={profile} size="row" />
          <View className="flex-1 gap-1">
            <Text variant="title" numberOfLines={1}>
              {profile.name}
            </Text>
            <Text variant="label" tone="muted">
              Switch Profile
            </Text>
          </View>
          <Icon icon={ChevronDown} size="inline" />
        </Pressable>
        <ListRow
          icon={Bookmark}
          title="My List"
          {...(list.status === "success"
            ? { detail: plural(list.data.length, "Title", "Titles") }
            : {})}
          onPress={() => router.push("/my-list")}
        />
        <ListRow icon={History} title="Watch History" onPress={() => router.push("/history")} />
        <View className="h-4" />
        <ListRow icon={UserRound} title="Account" onPress={() => router.push("/account")} />
        <ListRow icon={Settings2} title="App Settings" onPress={() => router.push("/settings")} />
        {accountSettings ? (
          <>
            <ListRow icon={TvMinimal} title="Devices" onPress={() => router.push("/devices")} />
            <ListRow
              icon={Airplay}
              title="Approve a Device"
              onPress={() => router.push("/approve-device")}
            />
          </>
        ) : null}
        {ownerSettings ? (
          <ListRow icon={Server} title="Owner Settings" onPress={() => router.push("/owner")} />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

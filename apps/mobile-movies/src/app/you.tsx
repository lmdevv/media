import { useAllPages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
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

import { PersonAvatar } from "@/components/profile-avatar";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { READABLE_COLUMN, Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { plural } from "@/lib/browse";
import { useMe } from "@/session/me";

export default function You() {
  const me = useMe();
  const platform = usePlatform();
  const list = useAllPages(platform.movies.myList.list, (paginationOpts) => ({ paginationOpts }));
  const accountSettings = me.scopes.includes("account");
  const admin = me.scopes.includes("admin");

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
          accessibilityLabel={`${me.username}, Sign Out`}
          onPress={() => router.push("/sign-out")}
          className="flex-row items-center gap-4 py-3 active:opacity-70"
        >
          <PersonAvatar name={me.username} />
          <View className="flex-1 gap-1">
            <Text variant="title" numberOfLines={1}>
              {me.username}
            </Text>
            <Text variant="label" tone="muted">
              Sign Out
            </Text>
          </View>
          <Icon icon={ChevronDown} size="inline" />
        </Pressable>
        <ListRow
          icon={Bookmark}
          title="My List"
          {...(list.status === "ready" && list.next.kind === "done"
            ? { detail: plural(list.rows.length, "Title", "Titles") }
            : {})}
          onPress={() => router.push("/my-list")}
        />
        <ListRow icon={History} title="Watch History" onPress={() => router.push("/history")} />
        <View className="h-4" />
        <ListRow icon={UserRound} title="Account" onPress={() => router.push("/account")} />
        <ListRow icon={Settings2} title="App Settings" onPress={() => router.push("/settings")} />
        {admin ? (
          <ListRow icon={TvMinimal} title="Devices" onPress={() => router.push("/devices")} />
        ) : null}
        {accountSettings ? (
          <ListRow
            icon={Airplay}
            title="Approve a Device"
            onPress={() => router.push("/approve-device")}
          />
        ) : null}
        {admin ? (
          <ListRow icon={Server} title="Owner Settings" onPress={() => router.push("/owner")} />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

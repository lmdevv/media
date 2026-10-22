/**
 * E01 · Welcome: the first launch, with no server yet. One action, connecting to a server (E02);
 * an invite link opened from Messages or Mail goes straight to accepting it (E08).
 */
import { router } from "expo-router";
import { ArrowRight, Info } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";

export default function Welcome() {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="never"
      className="flex-1 bg-canvas"
      contentContainerClassName="pb-row"
      style={{ paddingTop: insets.top }}
    >
      <View className="min-h-row-touch flex-row items-center justify-between px-mobile-edge pt-2 pb-3">
        <Text variant="largeTitle" accessibilityRole="header">
          [music]
        </Text>
        <View className="size-hit-target items-center justify-center">
          <Icon icon={Info} />
        </View>
      </View>
      <View className="px-mobile-edge">
        <View
          className="flex-row items-center justify-center gap-3 py-row"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <View className="size-ios-96 rounded-mobile-card bg-art" />
          <View className="size-ios-128 rounded-mobile-card bg-art" />
          <View className="size-ios-96 rounded-mobile-card bg-art" />
        </View>
        <Text variant="display" className="pt-6">
          {"Your music.\nEverywhere."}
        </Text>
        <Text tone="muted" className="pt-4 pb-row">
          {"Your collection, from your server.\nOne queue across all your devices."}
        </Text>
        <Button
          label="Connect to your server"
          icon={ArrowRight}
          onPress={() => router.push("/connect")}
        />
        <Text variant="secondary" tone="muted" className="pt-4 text-center">
          Already have an invite? Open the invite link.
        </Text>
      </View>
    </ScrollView>
  );
}

import type { PersonCard } from "@media/contracts/models/catalog";
import { router } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { facts } from "@/lib/format";
import { useServer } from "@/session/connection";

/** A row that opens the person's page. */
export function PersonRow({ person }: { readonly person: PersonCard }) {
  const { mediaUrl } = useServer();
  const uri = artworkUrl(mediaUrl, person.profile, "thumb");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={facts(person.name, person.knownFor)}
      onPress={() => router.push(`/person/${person.id}`)}
      className="min-h-14 flex-row items-center gap-4 active:opacity-70"
    >
      <View className="size-14 items-center justify-center overflow-hidden rounded-pill bg-surface-raised">
        {uri === undefined ? (
          <Text variant="labelStrong" tone="muted">
            {person.name.trim().charAt(0).toUpperCase()}
          </Text>
        ) : (
          <Image source={{ uri }} contentFit="cover" transition={150} className="size-full" />
        )}
      </View>
      <View className="flex-1 gap-0.5">
        <Text variant="bodyStrong" numberOfLines={1}>
          {person.name}
        </Text>
        {person.knownFor === null ? null : (
          <Text variant="secondary" tone="muted" numberOfLines={1}>
            {person.knownFor}
          </Text>
        )}
      </View>
      <View className="w-5 items-center">
        <Icon icon={ChevronRight} tone="muted" size="chevron" />
      </View>
    </Pressable>
  );
}

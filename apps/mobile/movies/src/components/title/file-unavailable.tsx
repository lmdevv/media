import { usePlatform } from "@media/sdk/react";
import { router } from "expo-router";
import { Ellipsis, Folder } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Image } from "@/components/ui/image";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import type { TitleDetail } from "@/lib/catalog";
import { useServer } from "@/session/connection";
import { useMe } from "@/session/me";

import { CENTERED_COLUMN } from "@/components/ui/page-layout";
import { AboutRow } from "./title-sections";
import { useRunner } from "./use-title-actions";

/** The page of a title whose files are all missing. */
export function FileUnavailable({ title }: { readonly title: TitleDetail }) {
  const { mediaUrl } = useServer();
  const canManage = useMe().scopes.includes("movies:edit");
  const scan = usePlatform().core.libraries.scan;
  const rescan = useRunner();
  const backdrop = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "card");

  return (
    <Screen
      scroll
      edges={["top"]}
      contentClassName={CENTERED_COLUMN}
      header={
        <NavHeader
          title={title.name}
          trailing={
            <IconButton
              icon={Ellipsis}
              label="More"
              onPress={() => router.push(`/title/${title.id}/actions`)}
            />
          }
        />
      }
    >
      <View className="aspect-video w-full overflow-hidden rounded-card bg-surface-raised">
        {backdrop === undefined ? null : (
          <Image source={{ uri: backdrop }} contentFit="cover" className="size-full" />
        )}
      </View>
      <View className="items-center gap-4 py-6">
        <View className="size-18 items-center justify-center rounded-pill bg-surface">
          <Icon icon={Folder} size="large" />
        </View>
        <Text variant="title" className="text-center" accessibilityRole="header">
          File unavailable
        </Text>
        <Text tone="muted" className="text-center">
          The share may be offline, or the file was moved.
        </Text>
      </View>
      {canManage ? (
        <Button
          label="Try Again"
          busy={rescan.busy}
          onPress={() => void rescan.run(() => scan({ libraryId: title.libraryId }))}
        />
      ) : null}
      {rescan.error === null ? null : (
        <Text variant="meta" tone="danger" className="text-center" accessibilityLiveRegion="polite">
          {rescan.error}
        </Text>
      )}
      <AboutRow title={title} />
    </Screen>
  );
}

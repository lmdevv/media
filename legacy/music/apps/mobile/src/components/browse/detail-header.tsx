/**
 * The iPad's horizontal header for an album, playlist, or artist (page 25 · P05, P06): 240pt art
 * on the left, and beside it, bottom-aligned, the mono facts, the title at 40/44, the page's own
 * lines (the artist, a description, whose it is), then its actions. Phones keep each page's own
 * header.
 */
import type { ReactNode } from "react";
import { View } from "react-native";

import { Artwork } from "@/components/ui/artwork";
import { Text } from "@/components/ui/text";

/** Props for `DetailHeader`. */
export interface DetailHeaderProps {
  readonly art: { readonly url: string | null; readonly recyclingKey?: string };
  /** The mono line over the title, such as `1991 · TRIP-HOP · 9 SONGS · 45 MIN`. */
  readonly facts?: string;
  readonly title: string;
  /** The lines under the title, such as the album's artist. */
  readonly children?: ReactNode;
  /** What sits at the foot of the text, such as Play and Shuffle. */
  readonly actions: ReactNode;
}

/** The art beside the facts, title, the page's lines, and its actions. */
export function DetailHeader({ art, facts, title, children, actions }: DetailHeaderProps) {
  return (
    <View className="flex-row items-end gap-8 pt-2 pb-6">
      <Artwork
        url={art.url}
        recyclingKey={art.recyclingKey}
        className="size-ios-240 shrink-0 rounded-lg"
      />
      <View className="min-w-0 flex-1 gap-4">
        <View className="gap-1">
          {facts === undefined ? null : (
            <Text variant="mono" tone="muted">
              {facts}
            </Text>
          )}
          <Text variant="display" accessibilityRole="header" numberOfLines={2}>
            {title}
          </Text>
          {children}
        </View>
        {actions}
      </View>
    </View>
  );
}

/** The header's room while its page loads: the art's block, so the list doesn't jump. */
export function DetailHeaderPlaceholder() {
  return (
    <View className="pt-2 pb-6">
      <View className="size-ios-240 rounded-lg bg-art" />
    </View>
  );
}

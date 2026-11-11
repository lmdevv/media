import type { TitleCard } from "@/lib/catalog";
import { Link } from "expo-router";
import { Pressable, View } from "react-native";

import { artworkUrl } from "@/lib/artwork";
import { watchHref } from "@/lib/routes";
import { useServer } from "@/session/connection";

import { useTitleMenu } from "./browse/title-menu";
import { Image } from "./ui/image";
import { Text } from "./ui/text";

/** Props for `TitlePoster`. */
export interface TitlePosterProps {
  readonly title: TitleCard;
  /**
   * The name under the artwork: 15pt in rails (`rail`), 13pt in an iPhone's grids and 15pt in an
   * iPad's (`grid`), or none.
   */
  readonly caption?: "rail" | "grid" | "none";
  /** A muted line under the name, such as `Movie · 2012`. */
  readonly detail?: string | undefined;
  /** The 2:3 poster, or the title's wide still. */
  readonly artwork?: "poster" | "still";
  /**
   * Tailwind width classes; Paper's rail widths for posters (112, 144 and 168pt by width class) and
   * stills (264, 320 and 360pt), and grids pass `flex-1`.
   */
  readonly widthClassName?: string;
}

/** A poster that opens the title, with its actions on a long press. */
export function TitlePoster({
  title,
  caption = "rail",
  detail,
  artwork = "poster",
  widthClassName = artwork === "still"
    ? "w-66 regular:w-80 wide:w-90"
    : "w-28 regular:w-36 wide:w-42",
}: TitlePosterProps) {
  const { mediaUrl } = useServer();
  const still = artwork === "still";

  const uri = still
    ? artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "card")
    : artworkUrl(mediaUrl, title.artwork.poster, "poster");

  const menu = useTitleMenu(title, watchHref({ titleId: title.id }));

  // One view around the link, sized here: its preview and menu render beside the poster and would
  // take a parent's gap of their own.
  return (
    <View className={widthClassName}>
      <Link href={`/title/${title.id}`} asChild>
        <Link.Trigger>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={title.name}
            accessibilityHint="Opens the title. Touch and hold for actions."
            className="w-full gap-1.5 active:opacity-80 regular:gap-2"
          >
            <View
              className={`${still ? "h-37 regular:h-45 wide:h-50.75" : "aspect-2/3"} w-full overflow-hidden rounded-control bg-surface-raised`}
            >
              {uri === undefined ? (
                <View className="flex-1 items-center justify-center p-2">
                  <Text variant="caption" tone="muted" className="text-center" numberOfLines={3}>
                    {title.name}
                  </Text>
                </View>
              ) : (
                <Image source={{ uri }} contentFit="cover" transition={150} className="size-full" />
              )}
            </View>
            {caption === "none" ? null : (
              <View className="gap-0.5">
                <Text variant={caption === "rail" ? "label" : "posterCaption"} numberOfLines={2}>
                  {title.name}
                </Text>
                {detail === undefined ? null : (
                  <Text variant="meta" tone="muted" numberOfLines={1}>
                    {detail}
                  </Text>
                )}
              </View>
            )}
          </Pressable>
        </Link.Trigger>
        <Link.Preview />
        {menu}
      </Link>
    </View>
  );
}

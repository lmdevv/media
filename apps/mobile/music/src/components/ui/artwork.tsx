import { Image as ExpoImage } from "expo-image";
import { View } from "react-native";
import { withUniwind } from "uniwind";

import { resolveMediaUrl } from "@/lib/media-url";
import { useServer } from "@/session/connection";
import { coverFailed } from "@/session/media-requests";

const Image = withUniwind(ExpoImage);

/**
 * A cover's cache key: its URL without the query, so a cover a new image ticket names again comes
 * from the cache. Covers are named by their content hash, so the path alone names the image.
 */
const artCacheKey = (url: string): string => url.split("?")[0] ?? url;

export interface ArtworkProps {
  /** The art URL as the server returns it, or null when the item has none. */
  readonly url: string | null;
  /** Size and corner classes, such as `size-12 rounded-md`. */
  readonly className: string;
  /** The item's ID in recycled list cells, so a reused cell never flashes the previous cover. */
  readonly recyclingKey?: string | undefined;
}

/** A square of artwork, decorative to VoiceOver (the row or card names the item). */
export function Artwork({ url, className, recyclingKey }: ArtworkProps) {
  const { mediaUrl } = useServer();
  const source = resolveMediaUrl(mediaUrl, url);

  return (
    <View
      className={`overflow-hidden bg-art ${className}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {source === null ? null : (
        <Image
          source={{ uri: source, cacheKey: artCacheKey(source) }}
          className="size-full"
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={150}
          recyclingKey={recyclingKey ?? source}
          onError={coverFailed(source)}
        />
      )}
    </View>
  );
}

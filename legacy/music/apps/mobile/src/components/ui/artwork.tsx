/**
 * Album and track artwork from the server: Expo Image, cached in memory and on disk, on Paper's
 * `--color-art` placeholder until it loads or when there is no art. URLs come back relative to the
 * server, so this resolves them against the connected origin.
 */
import { Image as ExpoImage } from "expo-image";
import { View } from "react-native";
import { withUniwind } from "uniwind";

import { resolveMediaUrl } from "@/lib/media-url";
import { useConnection } from "@/session/connection";

const Image = withUniwind(ExpoImage);

/** Props for `Artwork`. */
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
  const { origin } = useConnection();
  const source = resolveMediaUrl(origin, url);

  return (
    <View
      className={`overflow-hidden bg-art ${className}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {source === null ? null : (
        <Image
          source={source}
          className="size-full"
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={150}
          recyclingKey={recyclingKey ?? source}
        />
      )}
    </View>
  );
}

import { Image as ExpoImage } from "expo-image";
import { useState } from "react";
import { PixelRatio, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { withUniwind } from "uniwind";

import { artSource } from "@/lib/media-url";
import { useServer } from "@/session/connection";
import { coverFailed } from "@/session/media-requests";

const Image = withUniwind(ExpoImage);

export interface ArtworkProps {
  /** The art URL as the server returns it, or null when the item has none. */
  readonly url: string | null;
  /** Size and corner classes, such as `size-12 rounded-md`. */
  readonly className: string;
  /** The item's ID in recycled list cells, so a reused cell never flashes the previous cover. */
  readonly recyclingKey?: string | undefined;
  /**
   * `drawn`, the default, loads the cover at the size its frame is laid out at, once it is laid
   * out. `original` loads the stored image straight away, for a cover whose frame animates between
   * sizes, such as Now Playing's.
   */
  readonly resolution?: "drawn" | "original";
}

/** A square of artwork, decorative to VoiceOver (the row or card names the item). */
export function Artwork({ url, className, recyclingKey, resolution = "drawn" }: ArtworkProps) {
  const { mediaUrl } = useServer();
  // The frame's longer side in device pixels, since the cover fills the frame.
  const [pixels, setPixels] = useState<number | null>(null);
  const size = resolution === "original" ? "original" : pixels;
  const source = size === null ? null : artSource(mediaUrl, url, size);

  const measure = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;

    setPixels(Math.max(width, height) * PixelRatio.get());
  };

  return (
    <View
      className={`overflow-hidden bg-art ${className}`}
      onLayout={resolution === "drawn" ? measure : undefined}
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
          recyclingKey={recyclingKey ?? source.uri}
          onError={coverFailed(source.uri)}
        />
      )}
    </View>
  );
}

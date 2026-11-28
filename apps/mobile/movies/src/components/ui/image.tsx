import { artworkCacheKey } from "@media/contracts/artwork";
import { Image as ExpoImage } from "expo-image";
import type { ComponentProps } from "react";
import { withUniwind } from "uniwind";

/** expo-image with class names, for an image bundled with the app. */
export const BundledImage = withUniwind(ExpoImage);

type ImageProps = Omit<ComponentProps<typeof BundledImage>, "source"> & {
  readonly source: { readonly uri: string };
};

/**
 * A remote image with class names. The cache keeps it under its URL without the shareable ticket
 * artwork URLs carry, which changes every week while the image stays the same (ADR 0011).
 */
export function Image({ source, ...props }: ImageProps) {
  return (
    <BundledImage {...props} source={{ uri: source.uri, cacheKey: artworkCacheKey(source.uri) }} />
  );
}

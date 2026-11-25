import { cn } from "@/lib/utils";
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { placeholderGradient } from "@/lib/art";
import { artSrc, artSrcSet } from "@/lib/art-src";

/**
 * A cover or artist image. Without a URL, or when the image fails, it draws the deterministic
 * placeholder gradient for `seed`, so the same album looks the same everywhere. The image is
 * decorative (`alt=""`), but `children`, such as a play button on the cover, stay in the
 * accessibility tree, so the frame itself is not `aria-hidden`. The browser loads the smallest
 * resized copy that covers the size the image is laid out at (`sizes="auto"`, which needs
 * `loading="lazy"`); one without `auto` picks for the window's width.
 */
export function Artwork({
  url,
  seed,
  className,
  round = false,
  style,
  children,
}: {
  readonly url: string | null;
  readonly seed: string;
  readonly className?: string;
  readonly round?: boolean;
  readonly style?: CSSProperties;
  readonly children?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = url !== null && !failed;

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden",
        round ? "rounded-full" : "rounded-md",
        className,
      )}
      style={{ backgroundImage: placeholderGradient(seed, round ? 160 : 140), ...style }}
    >
      {showImage ? (
        <img
          src={artSrc(url)}
          srcSet={artSrcSet(url)}
          sizes="auto, 100vw"
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : null}
      {children}
    </div>
  );
}

/** The three accent bars that mark the playing song. */
export function PlayingBars({ className }: { readonly className?: string }) {
  return (
    <span className={cn("flex h-3.5 items-end gap-0.5", className)}>
      <span className="h-2 w-0.75 rounded-3xs bg-accent" />
      <span className="h-3.5 w-0.75 rounded-3xs bg-accent" />
      <span className="h-1.25 w-0.75 rounded-3xs bg-accent" />
      <span className="sr-only">Playing</span>
    </span>
  );
}

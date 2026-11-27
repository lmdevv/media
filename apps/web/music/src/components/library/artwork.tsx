import { cn } from "@/lib/utils";
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { placeholderGradient } from "@/lib/art";
import { coverSrc } from "@/lib/art-src";
import { useDrawnPixels } from "@/lib/use-drawn-pixels";

/**
 * A cover or artist image. Without a URL, or when the image fails, it draws the deterministic
 * placeholder gradient for `seed`, so the same album looks the same everywhere. The image is
 * decorative (`alt=""`), but `children`, such as a play button on the cover, stay in the
 * accessibility tree, so the frame itself is not `aria-hidden`. The image loads once the frame is
 * laid out, at the server's copy for the size the frame is drawn at (`coverSrc`).
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
  const [frame, pixels] = useDrawnPixels();
  const showImage = url !== null && !failed && pixels !== null;

  return (
    <div
      ref={frame}
      className={cn(
        "relative shrink-0 overflow-hidden",
        round ? "rounded-full" : "rounded-md",
        className,
      )}
      style={{ backgroundImage: placeholderGradient(seed, round ? 160 : 140), ...style }}
    >
      {showImage ? (
        <img
          src={coverSrc(url, pixels)}
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

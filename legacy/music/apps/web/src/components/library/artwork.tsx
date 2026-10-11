import { cn } from "@music/ui/lib/utils";
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { placeholderGradient } from "@/lib/art";

/**
 * A cover or artist image. Without a URL, or when the image fails, it draws the deterministic
 * placeholder gradient for `seed`, so the same album looks the same everywhere.
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
      aria-hidden
      className={cn(
        "relative shrink-0 overflow-hidden",
        round ? "rounded-full" : "rounded-md",
        className,
      )}
      style={{ backgroundImage: placeholderGradient(seed, round ? 160 : 140), ...style }}
    >
      {showImage ? (
        <img
          src={url}
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
    <span role="img" aria-label="Playing" className={cn("flex h-3.5 items-end gap-0.5", className)}>
      <span className="h-2 w-[3px] rounded-[1px] bg-accent" />
      <span className="h-3.5 w-[3px] rounded-[1px] bg-accent" />
      <span className="h-[5px] w-[3px] rounded-[1px] bg-accent" />
    </span>
  );
}

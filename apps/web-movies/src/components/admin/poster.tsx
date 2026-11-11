import { cn } from "@media/ui/lib/utils";
import { useState } from "react";

/**
 * A poster image, or a blank block of the same size when there is none or it fails to load, such
 * as when its file left the library folder.
 */
export function Poster({
  src,
  alt,
  className,
}: {
  readonly src: string | null | undefined;
  /** Empty for posters beside their title, which would only repeat it. */
  readonly alt: string;
  readonly className: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);

  if (src === null || src === undefined || failed === src) {
    return <span aria-hidden className={cn("shrink-0 bg-text/10", className)} />;
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(src)}
      className={cn("shrink-0 bg-text/10 object-cover", className)}
    />
  );
}

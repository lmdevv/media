import { cn } from "@media/ui/lib/utils";

import { Cube } from "./cube";

/**
 * The products this account opens, each its own client on this origin that a full page load opens
 * (ADR 0020), with the picture on its cube: Lucide's `play` and `music`, as on the app icons.
 */
export const PRODUCTS = [
  {
    href: "/movies",
    label: "Movies",
    faces: { top: "fill-movies-top", left: "fill-movies-left", right: "fill-movies-right" },
    picture: (
      <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
    ),
  },
  {
    href: "/music",
    label: "Music",
    faces: { top: "fill-music-top", left: "fill-music-left", right: "fill-music-right" },
    picture: (
      <>
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </>
    ),
  },
] as const;

export type Product = (typeof PRODUCTS)[number];

export function ProductCube({
  product,
  className,
}: {
  readonly product: Product;
  readonly className?: string;
}) {
  return (
    <Cube faces={product.faces} className={cn("size-6", className)}>
      {product.picture}
    </Cube>
  );
}

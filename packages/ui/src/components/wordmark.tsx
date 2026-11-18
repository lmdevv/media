import { cn } from "@media/ui/lib/utils";
import type { ComponentProps } from "react";

const NAMES = { movies: "Lar Movies", media: "Lar" } as const;

/**
 * A product's name in heavy accent type: Lar Movies unless `product` names another, such as
 * `media` (Lar) for the account client.
 */
export function Wordmark({
  product = "movies",
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & { readonly product?: keyof typeof NAMES }) {
  return (
    <span
      data-slot="wordmark"
      className={cn(
        "font-sans text-logo/7.5 font-heavy tracking-snug whitespace-nowrap text-accent select-none",
        className,
      )}
      {...props}
    >
      {NAMES[product]}
    </span>
  );
}

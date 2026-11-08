import { cn } from "@media/ui/lib/utils";
import type { ComponentProps } from "react";

/**
 * A product's wordmark in heavy accent type: `[movies]` unless `product` names another, such as
 * `media` for the account client.
 */
export function Wordmark({
  product = "movies",
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & { readonly product?: "movies" | "media" }) {
  return (
    <span
      data-slot="wordmark"
      className={cn(
        "font-sans text-logo/7.5 font-heavy tracking-snug whitespace-nowrap text-accent select-none",
        className,
      )}
      {...props}
    >
      [{product}]
    </span>
  );
}

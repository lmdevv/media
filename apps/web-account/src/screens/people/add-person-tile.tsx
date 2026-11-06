import { PlusIcon } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * The dashed tile that ends a picker, as `AddProfileTile` draws it, labelled "Add someone":
 * `AddProfileTile` fixes its label to "Add profile".
 */
export function AddPersonTile(props: Omit<ComponentProps<"button">, "type" | "children">) {
  return (
    <button
      type="button"
      className="group/tile flex w-35 shrink-0 cursor-pointer flex-col items-center gap-2.5 rounded-poster font-sans outline-none md:w-40 md:gap-3.5"
      {...props}
    >
      <span className="flex size-26 items-center justify-center rounded-pill bg-text/8 text-text transition-shadow group-hover/tile:ring-3 group-hover/tile:ring-accent group-hover/tile:ring-offset-3 group-hover/tile:ring-offset-page group-focus-visible/tile:ring-3 group-focus-visible/tile:ring-accent group-focus-visible/tile:ring-offset-3 group-focus-visible/tile:ring-offset-page md:size-40 md:rounded-poster md:border-control md:border-dashed md:border-hairline md:bg-transparent md:text-text-muted">
        <PlusIcon className="size-9 md:size-11" strokeWidth={1.5} aria-hidden />
      </span>
      <span className="text-lead/body font-semibold text-text-muted transition-colors md:text-heading/heading md:font-medium md:group-hover/tile:font-semibold md:group-hover/tile:text-text md:group-focus-visible/tile:font-semibold md:group-focus-visible/tile:text-text">
        Add someone
      </span>
      <span className="h-4" />
    </button>
  );
}

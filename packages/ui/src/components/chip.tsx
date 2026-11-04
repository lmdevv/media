import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@media/ui/lib/utils";
import type { ComponentProps } from "react";

/**
 * A pill filter toggle such as `All` or `Sci-fi`. `selected` fills it white on dark (black on
 * light) and sets `aria-pressed`.
 */
export function Chip({
  selected = false,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { readonly selected?: boolean }) {
  return (
    <button
      data-slot="chip"
      type={type}
      aria-pressed={selected}
      className={cn(
        "inline-flex h-8 shrink-0 cursor-pointer items-center rounded-pill px-3.5 font-sans text-label/4 transition-colors",
        selected
          ? "bg-text font-semibold text-bg"
          : "bg-surface-raised font-medium text-text hover:bg-text/15",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A phone shortcut chip under the large title, such as `Movies` or `Room live`. `live` adds the red
 * outline and dot of an active watch room. Pass the router's link through `render`.
 */
export function NavChip({
  live = false,
  className,
  render,
  children,
  ...props
}: useRender.ComponentProps<"a"> & { readonly live?: boolean }) {
  return useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        className: cn(
          "on-media inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill px-3.5 font-sans text-small/4.5 font-semibold whitespace-nowrap",
          live ? "border border-accent" : "bg-text/14",
          className,
        ),
        children: (
          <>
            {live ? (
              <span aria-hidden className="size-1.5 shrink-0 rounded-pill bg-accent" />
            ) : null}
            {children}
          </>
        ),
      },
      props,
    ),
  });
}

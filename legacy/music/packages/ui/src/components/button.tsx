import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@music/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

/**
 * Pill buttons from the Paper components page. `primary` is the accent Play button, `solid` the
 * neutral dark pill used for most confirmations, `secondary` the surface pill, `outline` and
 * `danger` the bordered pills, and `ghost` the quiet text button.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full font-sans font-semibold whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-(--opacity-disabled) aria-busy:pointer-events-none aria-busy:opacity-(--opacity-muted) [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-on-accent hover:bg-accent/90",
        solid: "bg-text text-text-inverse hover:bg-text/85",
        secondary: "bg-surface text-text hover:bg-border",
        outline: "border border-border text-text hover:bg-surface",
        danger: "border border-border text-danger hover:bg-danger/10",
        ghost: "font-medium text-text-muted hover:text-text",
        icon: "rounded-full text-text hover:bg-surface",
        "icon-outline": "rounded-full border border-border text-text hover:bg-surface",
      },
      size: {
        sm: "h-9 px-3.5 text-sm/xs [&_svg:not([class*='size-'])]:size-3.5",
        md: "h-row px-5 text-base/sm [&_svg:not([class*='size-'])]:size-4",
        lg: "h-12 px-5 text-md/base [&_svg:not([class*='size-'])]:size-4",
        "icon-sm": "size-8 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-9 [&_svg:not([class*='size-'])]:size-5",
        "icon-lg": "size-row [&_svg:not([class*='size-'])]:size-4.5",
      },
    },
    compoundVariants: [
      { variant: "primary", size: "md", className: "pr-5 pl-4" },
      { variant: "ghost", size: "md", className: "px-4" },
    ],
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

/** Visual options for {@link Button}. */
export type ButtonVariants = VariantProps<typeof buttonVariants>;

/**
 * A pill button. Pass `pending` while its action runs: it shows the Paper "Saving…" state and
 * ignores clicks until the action settles.
 */
export function Button({
  className,
  variant,
  size,
  pending = false,
  disabled,
  ...props
}: ButtonPrimitive.Props & ButtonVariants & { readonly pending?: boolean }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      aria-busy={pending || undefined}
      disabled={disabled === true || pending}
      focusableWhenDisabled={pending}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

/** Class names for elements that look like a button but are not one, such as router links. */
export const buttonClassName = (
  options: ButtonVariants & { readonly className?: string },
): string =>
  cn(buttonVariants({ variant: options.variant, size: options.size }), options.className);

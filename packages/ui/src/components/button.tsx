import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { cn } from "@media/ui/lib/utils";
import type { VariantProps } from "class-variance-authority";

/**
 * A Paper button. Pick the `variant` by role and the `size` by context: `lg` on the hero, `md` in
 * forms and rows, `sm` in panels, `pill` on phones, `icon` for the round icon button (give it an `aria-label`).
 */
export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

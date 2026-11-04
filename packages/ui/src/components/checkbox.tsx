import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "@media/ui/lib/utils";
import { CheckIcon } from "lucide-react";

/**
 * The Paper checkbox: an 18px box with a muted outline that fills Netflix red with a check when
 * on, as in Create API key. Label it with a wrapping `<label>` or `aria-label`.
 */
export function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-poster border-control border-text-muted transition-colors data-checked:border-accent data-checked:bg-accent data-disabled:cursor-not-allowed data-disabled:opacity-(--opacity-disabled)",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex text-on-accent">
        <CheckIcon className="size-3" strokeWidth={3} aria-hidden />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

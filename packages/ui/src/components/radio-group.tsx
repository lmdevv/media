import { Radio } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@media/ui/lib/utils";

/** A group of {@link RadioItem}s; control it with `value` and `onValueChange`. */
export function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

/**
 * The Paper radio: a 16px muted ring that becomes a thick Netflix-red ring around a white center
 * when chosen, as in the metadata match picker and the migration source. Label it with a wrapping
 * `<label>`.
 */
export function RadioItem({ className, ...props }: Radio.Root.Props) {
  return (
    <Radio.Root
      data-slot="radio"
      className={cn(
        "size-4 shrink-0 cursor-pointer rounded-pill border-control border-text-muted transition-[border] data-checked:border-radio-checked data-checked:border-accent data-checked:bg-on-accent data-disabled:cursor-not-allowed data-disabled:opacity-(--opacity-disabled)",
        className,
      )}
      {...props}
    />
  );
}

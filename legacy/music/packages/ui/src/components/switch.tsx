import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@music/ui/lib/utils";

/** The Paper toggle: a 44×26 pill, neutral when on (switches stay neutral, not accent). */
export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-[26px] w-11 shrink-0 cursor-pointer items-center rounded-full p-[3px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-checked:bg-text data-unchecked:bg-border data-disabled:cursor-not-allowed data-disabled:opacity-(--opacity-disabled)",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 rounded-full bg-text-inverse shadow-sm transition-transform data-checked:translate-x-[18px] data-unchecked:translate-x-0 data-unchecked:bg-bg" />
    </SwitchPrimitive.Root>
  );
}

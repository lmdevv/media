import { cn } from "@music/ui/lib/utils";

/** One choice in a {@link Segmented} control. */
export interface SegmentedOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

/**
 * The Paper segmented control (Appearance, Jobs filter): a surface track with the chosen option
 * lifted onto the background. It is a radio group for assistive technology.
 */
export function Segmented<Value extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  readonly value: Value;
  readonly options: ReadonlyArray<SegmentedOption<Value>>;
  readonly onChange: (value: Value) => void;
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("flex rounded-full bg-surface p-[3px]", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-[30px] cursor-pointer items-center rounded-full px-3.5 font-sans text-sm/xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              selected
                ? "bg-bg font-semibold text-text shadow-[0_1px_3px_color-mix(in_oklab,var(--color-text)_12%,transparent)]"
                : "font-medium text-text-muted hover:text-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

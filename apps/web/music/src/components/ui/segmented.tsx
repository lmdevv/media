import { cn } from "@/lib/utils";
import { useId } from "react";

/** One choice in a {@link Segmented} control. */
export interface SegmentedOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

/**
 * The segmented control (Appearance, Jobs filter): a surface track with the chosen option
 * lifted onto the background. Each option is a native radio button, so the group takes one Tab
 * stop and the arrow keys change the choice.
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
  const name = useId();

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("flex rounded-full bg-surface p-0.75", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;

        return (
          <label
            key={option.value}
            className={cn(
              "relative flex h-7.5 cursor-pointer items-center rounded-full px-3.5 font-sans text-sm/xs transition-colors",
              selected
                ? "bg-bg font-semibold text-text shadow-segment"
                : "font-medium text-text-muted hover:text-text",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="absolute inset-0 cursor-pointer appearance-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

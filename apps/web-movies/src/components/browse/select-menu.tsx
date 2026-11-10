import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@media/ui/components/dropdown-menu";
import { cn } from "@media/ui/lib/utils";
import type { ReactNode } from "react";

/** One choice of a {@link SelectMenu}. */
export interface SelectOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** Muted text after the label, such as `10 episodes`. */
  readonly detail?: string | undefined;
}

/**
 * A button that opens a short list of choices, as Paper draws the Sort and Season controls. Choosing
 * one closes the list.
 *
 * @param children - The button's content, such as `Sort Recently added ⌄`.
 */
export function SelectMenu<Value extends string>({
  label,
  value,
  options,
  onChange,
  children,
  className,
}: {
  /** Accessible name of the button, such as `Sort`. */
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<SelectOption<Value>>;
  readonly onChange: (value: Value) => void;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className={cn(
          "flex cursor-pointer items-center rounded-control font-sans text-text transition-colors outline-none hover:bg-text/6 focus-visible:outline-2",
          className,
        )}
      >
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={(next: Value) => onChange(next)}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              closeOnClick
              className="gap-2 rounded-inner py-2 pr-9 pl-3 text-label/label text-text focus:bg-text/8 [&_[data-slot=dropdown-menu-radio-item-indicator]]:right-3"
            >
              <span className="font-semibold">{option.label}</span>
              {option.detail === undefined ? null : (
                <span className="text-text-muted">{option.detail}</span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

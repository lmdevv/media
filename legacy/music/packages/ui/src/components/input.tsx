import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@music/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";

/**
 * Text fields from the Paper inputs row: a filled surface at rest, and a background with an
 * accent (focus) or danger (`aria-invalid`) ring. `lg` is the 44px form field; `md` the 40px one.
 */
const fieldVariants = cva(
  "flex w-full shrink-0 items-center gap-2.5 rounded-sm border-field border-transparent bg-surface text-text transition-colors has-[input:focus-visible]:border-accent has-[input:focus-visible]:bg-bg has-[input[aria-invalid=true]]:border-danger has-[input[aria-invalid=true]]:bg-bg has-[input:disabled]:opacity-(--opacity-disabled) [&_svg]:shrink-0 [&_svg]:text-text-muted",
  {
    variants: {
      size: {
        sm: "h-9 px-3 text-base/sm [&_svg:not([class*='size-'])]:size-4",
        md: "h-row px-3 text-base/sm [&_svg:not([class*='size-'])]:size-4",
        lg: "h-11 px-3.5 text-md/base [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: { size: "lg" },
  },
);

/** Props for {@link Input}; `start` and `end` render inside the field, beside the text. */
export type InputProps = Omit<InputPrimitive.Props, "size"> &
  VariantProps<typeof fieldVariants> & {
    readonly start?: ReactNode;
    readonly end?: ReactNode;
    readonly fieldClassName?: string;
  };

/** A labelled-elsewhere text input with optional leading and trailing adornments. */
export function Input({ className, fieldClassName, size, start, end, ...props }: InputProps) {
  return (
    <div data-slot="input-field" className={cn(fieldVariants({ size }), fieldClassName)}>
      {start}
      <InputPrimitive
        data-slot="input"
        className={cn(
          "h-full min-w-0 grow bg-transparent outline-none placeholder:text-text-muted",
          className,
        )}
        {...props}
      />
      {end}
    </div>
  );
}

/** The small label above a field. */
export function FieldLabel({
  className,
  ...props
}: ComponentProps<"label"> & { readonly htmlFor: string }) {
  return (
    <label className={cn("font-sans text-sm/xs font-medium text-text", className)} {...props} />
  );
}

/** Help or error text under a field. Set `tone="danger"` for errors. */
export function FieldHint({
  className,
  tone = "muted",
  ...props
}: ComponentProps<"p"> & { readonly tone?: "muted" | "danger" }) {
  return (
    <p
      className={cn(
        "font-sans text-sm/xs",
        tone === "danger" ? "text-danger" : "text-text-muted",
        className,
      )}
      {...props}
    />
  );
}

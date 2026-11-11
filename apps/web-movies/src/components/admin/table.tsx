import { cn } from "@media/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * A data table drawn as flex rows, so columns are fixed-width lanes that line up across rows.
 * `ruled` draws hairlines between rows, as on API keys; otherwise rows sit on whitespace, as on
 * the admin screens.
 */
export function Table({
  label,
  ruled = false,
  className,
  children,
}: {
  readonly label: string;
  readonly ruled?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="table"
      aria-label={label}
      data-ruled={ruled || undefined}
      className={cn(
        "group/table flex min-w-0 flex-col overflow-x-auto",
        ruled ? "border-t border-hairline" : "gap-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The header row of a {@link Table}. */
export function TableHead({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="row"
      className={cn(
        "flex h-8 shrink-0 items-center gap-3 group-data-ruled/table:h-9 group-data-ruled/table:border-b group-data-ruled/table:border-hairline",
        "px-3 group-data-ruled/table:px-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A small-caps column label; size it with a width class to set the column's lane. */
export function Column({
  className,
  children,
}: {
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <span
      role="columnheader"
      className={cn(
        "shrink-0 font-sans text-micro/caption font-semibold tracking-eyebrow text-text-muted uppercase group-data-ruled/table:text-caption/caption group-data-ruled/table:tracking-caps",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A body row of a {@link Table}. */
export function TableRow({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="row"
      className={cn(
        "flex h-11 shrink-0 items-center gap-3 px-3 group-data-ruled/table:h-13 group-data-ruled/table:border-b group-data-ruled/table:border-hairline group-data-ruled/table:px-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A cell in a {@link TableRow}; give it the same width class as its column. */
export function Cell({
  className,
  children,
}: {
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div role="cell" className={cn("min-w-0 shrink-0", className)}>
      {children}
    </div>
  );
}

/** A colored dot before a status word, such as Ready or Scanning. */
export function StatusDot({
  tone,
  className,
}: {
  readonly tone: "success" | "warning" | "danger" | "muted";
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-pill",
        tone === "success" && "bg-success",
        tone === "warning" && "bg-warning",
        tone === "danger" && "bg-danger",
        tone === "muted" && "bg-text-muted",
        className,
      )}
    />
  );
}

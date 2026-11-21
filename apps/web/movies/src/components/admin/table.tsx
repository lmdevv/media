import { cn } from "@media/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * A data table drawn as flex rows, so columns are fixed-width lanes that line up across rows. Put a
 * {@link TableHead} and a {@link TableBody} in it. `ruled` draws hairlines between rows, as on API
 * keys; otherwise rows sit on whitespace, as on the admin screens.
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
    <table
      aria-label={label}
      data-ruled={ruled || undefined}
      className={cn(
        "group/table flex min-w-0 flex-col overflow-x-auto",
        ruled ? "border-t border-hairline" : "gap-1",
        className,
      )}
    >
      {children}
    </table>
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
    <thead>
      <tr
        className={cn(
          "flex h-8 shrink-0 items-center gap-3 group-data-ruled/table:h-9 group-data-ruled/table:border-b group-data-ruled/table:border-hairline",
          "px-3 group-data-ruled/table:px-0",
          className,
        )}
      >
        {children}
      </tr>
    </thead>
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
    <th
      scope="col"
      className={cn(
        "shrink-0 text-start font-sans text-micro/caption font-semibold tracking-eyebrow text-text-muted uppercase group-data-ruled/table:text-caption/caption group-data-ruled/table:tracking-caps",
        className,
      )}
    >
      {children}
    </th>
  );
}

/** The body of a {@link Table}, holding its {@link TableRow}s. */
export function TableBody({ children }: { readonly children: ReactNode }) {
  return <tbody className="flex flex-col gap-1 group-data-ruled/table:gap-0">{children}</tbody>;
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
    <tr
      className={cn(
        "flex h-11 shrink-0 items-center gap-3 px-3 group-data-ruled/table:h-13 group-data-ruled/table:border-b group-data-ruled/table:border-hairline group-data-ruled/table:px-0",
        className,
      )}
    >
      {children}
    </tr>
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
  return <td className={cn("min-w-0 shrink-0", className)}>{children}</td>;
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

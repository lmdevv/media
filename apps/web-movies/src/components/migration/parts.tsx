import type { ReactNode } from "react";

import { formatCount } from "@/components/admin/format";

/** A large count over its muted label, as in the Review and Done summaries. */
export function Stat({
  value,
  label,
  detail,
}: {
  readonly value: number;
  readonly label: string;
  /** Follows the label on the same line, such as the names of the users imported. */
  readonly detail?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-sans text-title/title font-bold tracking-display text-text">
        {formatCount(value)}
      </span>
      <span className="max-w-60 truncate font-sans text-label/label text-text-muted">
        {detail === undefined || detail === "" ? label : `${label} · ${detail}`}
      </span>
    </div>
  );
}

/** A row of {@link Stat}s. */
export function Stats({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap gap-x-14 gap-y-6">{children}</div>;
}

/** A muted line after a warning dot: something the import skips or keeps. Never a stripe. */
export function Caution({ children }: { readonly children: ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 font-sans text-label/label text-text-muted">
      <span aria-hidden className="size-1.5 shrink-0 rounded-pill bg-warning" />
      {children}
    </p>
  );
}

/** A small muted heading over a Review section. */
export function SectionLabel({ id, children }: { readonly id: string; readonly children: string }) {
  return (
    <h2 id={id} className="font-sans text-label/label font-medium text-text-muted">
      {children}
    </h2>
  );
}

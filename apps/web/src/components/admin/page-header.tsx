import { cn } from "@media/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { Fragment } from "react";
import type { ReactNode } from "react";

/** Class names for a breadcrumb link in a {@link PageHeader}. */
export const crumbLinkClass =
  "font-sans text-label/label font-medium text-text-muted transition-colors hover:text-text";

/**
 * A settings screen's heading: an optional breadcrumb, the title, an optional mono line of facts,
 * and actions on the right.
 */
export function PageHeader({
  title,
  crumbs,
  facts,
  actions,
  className,
}: {
  readonly title: string;
  /** Links back up the hierarchy, styled with {@link crumbLinkClass}. */
  readonly crumbs?: ReadonlyArray<ReactNode>;
  readonly facts?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap justify-between gap-x-6 gap-y-4",
        crumbs === undefined && facts === undefined ? "items-center" : "items-end",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        {crumbs === undefined ? null : (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
            {crumbs.map((crumb, index) => (
              <Fragment key={index}>
                {crumb}
                <ChevronRightIcon
                  className="size-3 text-text-muted"
                  strokeWidth={1.75}
                  aria-hidden
                />
              </Fragment>
            ))}
          </nav>
        )}
        <h1 className="font-sans text-title/title font-bold tracking-display text-text">{title}</h1>
        {facts === undefined ? null : (
          <p className="truncate font-mono text-caption/label text-text-muted">{facts}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

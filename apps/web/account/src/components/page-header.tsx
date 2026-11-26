import { cn } from "@media/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { Fragment } from "react";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  crumbs,
  facts,
  actions,
}: {
  readonly title: string;
  readonly crumbs?: ReadonlyArray<ReactNode>;
  readonly facts?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 md:col-span-full md:min-h-46 md:pb-10">
      <div className="flex min-w-0 flex-col gap-2">
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
        <h1
          className={cn(
            "font-display font-heavy tracking-display break-words text-text font-stretch-112%",
            "text-title/title md:text-display/display",
          )}
        >
          {title}
        </h1>
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

import { cn } from "@media/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * A centered whole-page state for empty libraries, failures and waits: an optional visual, a heavy
 * title, one muted line, and actions. Use it instead of banners or bordered error cards.
 *
 * @param visual - Sits above the title, such as a `Spinner` or an illustration.
 */
export function CalmState({
  title,
  description,
  visual,
  actions,
  className,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly visual?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="calm-state"
      className={cn(
        "mx-auto flex w-full max-w-130 flex-col items-center gap-8 text-center font-sans",
        className,
      )}
    >
      {visual}
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-title/title font-heavy tracking-tight text-text">{title}</h2>
        {description === undefined ? null : (
          <p className="text-body/body text-text-muted">{description}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center justify-center gap-3">{actions}</div>
      )}
    </div>
  );
}

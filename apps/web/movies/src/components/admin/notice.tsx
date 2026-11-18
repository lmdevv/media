import { cn } from "@media/ui/lib/utils";
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A warning-tinted line with a triangle, such as “You won’t see this key again” or “6 files
 * disappeared”. It is a tint, never a colored stripe.
 *
 * @param action - Sits at the right end, such as a Review button.
 */
export function Notice({
  children,
  action,
  outlined = false,
  className,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
  /** Adds a warning hairline, as in the Key created dialog. */
  readonly outlined?: boolean;
  readonly className?: string;
}) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-center gap-3 rounded-control bg-warning/10 px-3.5 py-3",
        outlined && "border border-warning/30",
        className,
      )}
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-warning" strokeWidth={1.75} aria-hidden />
      <div className="min-w-0 flex-1 font-sans text-label/label text-text">{children}</div>
      {action}
    </div>
  );
}

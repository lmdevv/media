import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { cn } from "@music/ui/lib/utils";

/** An iOS-style bottom sheet for phone layouts, such as the device sheet. */
export const Sheet = SheetPrimitive.Root;

/**
 * The sheet panel: rounded top corners, a grabber, the heavy title, and a muted subtitle. The page
 * behind is dimmed.
 */
export function SheetContent({
  className,
  children,
  title,
  description,
  ...props
}: SheetPrimitive.Popup.Props & {
  readonly title: string;
  readonly description?: string | undefined;
}) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Backdrop className="fixed inset-0 z-50 bg-dark-canvas/45 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <SheetPrimitive.Popup
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-dvh-sheet flex-col gap-1 overflow-y-auto rounded-t-sheet bg-bg px-4 pt-2.5 pb-row text-text transition-transform duration-200 ease-out outline-none data-ending-style:translate-y-full data-starting-style:translate-y-full",
          className,
        )}
        {...props}
      >
        <div
          aria-hidden
          className="mb-3 h-1.25 w-row shrink-0 self-center rounded-full bg-border"
        />
        <div className="flex flex-col gap-0.5 px-1 pb-3">
          <SheetPrimitive.Title className="font-sans text-lg/md font-heavy tracking-tight text-text">
            {title}
          </SheetPrimitive.Title>
          {description === undefined ? null : (
            <SheetPrimitive.Description className="font-sans text-sm/xs text-text-muted">
              {description}
            </SheetPrimitive.Description>
          )}
        </div>
        {children}
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  );
}

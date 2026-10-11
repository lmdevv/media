import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "@music/ui/lib/utils";
import { XIcon } from "lucide-react";
import type { ComponentProps } from "react";

/** A modal dialog. Control it with `open` and `onOpenChange`. */
export const Dialog = DialogPrimitive.Root;

/** Closes the surrounding {@link Dialog}. Use `render` to supply your own button. */
export const DialogClose = DialogPrimitive.Close;

/** The dimmed, blurred layer behind dialogs and the command menu. */
export function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-backdrop"
      className={cn(
        "fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] duration-100 data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The Paper dialog: a 560px raised card with 28px padding. `title` and `description` render the
 * heavy heading and muted lead; a close button sits top right unless `showClose` is false.
 */
export function DialogContent({
  className,
  children,
  title,
  description,
  showClose = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  readonly title: string;
  readonly description?: string | undefined;
  readonly showClose?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogBackdrop />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-dialog max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-6 overflow-y-auto rounded-lg bg-surface-raised p-7 text-text shadow-[0_32px_80px_color-mix(in_oklab,var(--color-text)_24%,transparent)] duration-100 outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
          className,
        )}
        {...props}
      >
        <div className={cn("flex flex-col gap-1", showClose && "pr-10")}>
          <DialogPrimitive.Title className="font-sans text-xl/xl font-heavy tracking-tight text-text">
            {title}
          </DialogPrimitive.Title>
          {description === undefined ? null : (
            <DialogPrimitive.Description className="font-sans text-base/base text-text-muted">
              {description}
            </DialogPrimitive.Description>
          )}
        </div>
        {children}
        {/* Last in the DOM so opening the dialog focuses its first field or action, not Close. */}
        {showClose ? (
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute top-6 right-6 flex size-8 cursor-pointer items-center justify-center rounded-full text-text-muted hover:bg-surface hover:text-text"
          >
            <XIcon className="size-5" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

/** The right-aligned action row at the bottom of a dialog. */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center justify-end gap-2 pt-1", className)} {...props} />;
}

/** The portal for a custom full-screen {@link Dialog} surface, such as Now Playing. */
export const DialogPortal = DialogPrimitive.Portal;

/** A bare dialog surface for full-screen views; style it yourself. */
export const DialogPopup = DialogPrimitive.Popup;

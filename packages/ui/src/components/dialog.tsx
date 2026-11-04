import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "@media/ui/lib/utils";
import { XIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/** A modal dialog. Control it with `open` and `onOpenChange`. */
export const Dialog = DialogPrimitive.Root;

/** Closes the surrounding {@link Dialog}. Pass your own button through `render`. */
export const DialogClose = DialogPrimitive.Close;

/**
 * The Paper dialog over the scrim: a surface card with a heading row and a close button. Put the
 * body in {@link DialogBody} and the actions in {@link DialogFooter}.
 *
 * @param size - `md` is the 560px dialog (Create API key); `sm` is the 480px confirmation.
 * @param description - Read by assistive technology with the title; render visible copy in the body.
 * @param container - Where the dialog renders, such as a full-screen player; the body when undefined.
 */
export function DialogContent({
  title,
  description,
  size = "md",
  container,
  className,
  children,
  ...props
}: Omit<DialogPrimitive.Popup.Props, "title" | "children"> & {
  readonly title: string;
  readonly description?: string | undefined;
  readonly size?: "sm" | "md";
  readonly container?: HTMLElement | undefined;
  readonly children: ReactNode;
}) {
  return (
    <DialogPrimitive.Portal container={container}>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <DialogPrimitive.Popup
        data-slot="dialog"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-var(--spacing-8))] max-w-[calc(100vw-var(--spacing-8))] -translate-1/2 flex-col overflow-y-auto rounded-card border border-hairline bg-surface font-sans text-text shadow-overlay transition-[opacity,scale] duration-150 outline-none data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0",
          size === "md" ? "w-dialog" : "w-120",
          className,
        )}
        {...props}
      >
        <div className="flex items-center justify-between gap-4 px-6 pt-6 pb-2">
          <DialogPrimitive.Title className="text-heading/heading font-bold tracking-tight text-text">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Close
            aria-label="Close"
            className="-m-1.5 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-text-muted transition-colors hover:bg-text/6 hover:text-text"
          >
            <XIcon className="size-5" strokeWidth={1.75} aria-hidden />
          </DialogPrimitive.Close>
        </div>
        {description === undefined ? null : (
          <DialogPrimitive.Description className="sr-only">
            {description}
          </DialogPrimitive.Description>
        )}
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

/** The padded body of a {@link DialogContent}. */
export function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("flex flex-col gap-6 px-6 pt-4 pb-6", className)}
      {...props}
    />
  );
}

/** The right-aligned action row under a hairline at the bottom of a {@link DialogContent}. */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex items-center justify-end gap-2 border-t border-hairline px-6 py-4",
        className,
      )}
      {...props}
    />
  );
}

import { Dialog, DialogContent } from "@media/ui/components/dialog";

/**
 * A title's trailer in a dialog, loaded apart from the title page. The player frame exists only
 * while the dialog is open, so closing it stops the video.
 */
export function TrailerDialog({
  open,
  onOpenChange,
  title,
  frameTitle,
  src,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly frameTitle: string;
  readonly src: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} className="w-content">
        <div className="px-6 pt-2 pb-6">
          {open ? (
            <iframe
              src={src}
              title={frameTitle}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              className="aspect-video w-full rounded-control bg-dark-bg"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

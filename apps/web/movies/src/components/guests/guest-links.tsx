import { Button } from "@media/ui/components/button";
import { Dialog, DialogBody, DialogContent } from "@media/ui/components/dialog";
import { GuestLinksForm } from "@media/ui/components/guest-links-form";
import type { GuestLinkButtonProps } from "@media/ui/components/guest-links-form";
import { Input } from "@media/ui/components/input";
import { LinkIcon } from "lucide-react";
import type { GuestLinkSelection } from "@media/ui/lib/guest-link-dialog";

const GUEST_VARIANTS = { primary: "primary", secondary: "subtle", danger: "destructive" } as const;

function GuestButton({ tone, ...props }: GuestLinkButtonProps) {
  return <Button variant={GUEST_VARIANTS[tone]} size="dialog" {...props} />;
}

/** The title's action uses the page's sharing permission and dialog owner. */
export function TitleGuestLinks({
  phone = false,
  onClick,
}: {
  readonly phone?: boolean;
  readonly onClick: (() => void) | null;
}) {
  if (onClick === null) return null;

  return phone ? (
    <button
      type="button"
      onClick={onClick}
      className="flex w-26 cursor-pointer flex-col items-center gap-1.5 text-caption/caption text-text-muted"
    >
      <LinkIcon className="size-5.5 text-text" aria-hidden />
      Guest link
    </button>
  ) : (
    <Button
      variant="icon"
      size="icon"
      className="size-12"
      aria-label="Guest link"
      onClick={onClick}
    >
      <LinkIcon aria-hidden />
    </Button>
  );
}

/** Lives above the phone and desktop action layouts so resizing preserves the one-time address. */
export function TitleGuestLinkDialog({
  selected,
  onClose,
}: {
  readonly selected: GuestLinkSelection;
  readonly onClose: () => void;
}) {
  return (
    <GuestLinksForm target={selected.target} Button={GuestButton} Input={Input}>
      {(form, pending) => (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next && !pending) onClose();
          }}
        >
          <DialogContent title={`Share ${selected.name}`}>
            <DialogBody>{form}</DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </GuestLinksForm>
  );
}

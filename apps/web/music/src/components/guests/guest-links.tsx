import { GuestLinksForm } from "@media/ui/components/guest-links-form";
import type { GuestLinkButtonProps } from "@media/ui/components/guest-links-form";
import type { GuestTarget } from "@media/ui/lib/guest-links";
import { useGuestLinks, useMayShareGuests } from "@media/ui/lib/use-guest-links";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

function GuestButton({ tone, ...props }: GuestLinkButtonProps) {
  return <Button variant={tone} {...props} />;
}

function GuestForm({ target }: { readonly target: GuestTarget }) {
  const model = useGuestLinks(target);

  return <GuestLinksForm model={model} Button={GuestButton} Input={Input} />;
}

/** The menu entry stays absent until this session is allowed to share. */
export function GuestLinkMenuItem({ onClick }: { readonly onClick: () => void }) {
  const allowed = useMayShareGuests();

  return allowed ? <DropdownMenuItem onClick={onClick}>Guest link</DropdownMenuItem> : null;
}

/** The dialog lives outside the menu so closing the menu preserves the active form. */
export function GuestLinkDialog({
  target,
  name,
  open,
  onOpenChange,
}: {
  readonly target: GuestTarget;
  readonly name: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const allowed = useMayShareGuests();

  return (
    <Dialog open={open && allowed} onOpenChange={onOpenChange}>
      {open && allowed ? (
        <DialogContent title={`Share ${name}`}>
          <GuestForm key={JSON.stringify(target)} target={target} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

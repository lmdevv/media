import { Button } from "@media/ui/components/button";
import { Dialog, DialogBody, DialogContent } from "@media/ui/components/dialog";
import { GuestLinksForm } from "@media/ui/components/guest-links-form";
import type { GuestLinkButtonProps } from "@media/ui/components/guest-links-form";
import { Input } from "@media/ui/components/input";
import type { TitleDetail } from "@/lib/catalog";
import type { GuestTarget } from "@media/ui/lib/guest-links";
import { useGuestLinks, useMayShareGuests } from "@media/ui/lib/use-guest-links";
import { LinkIcon } from "lucide-react";
import { useState } from "react";

const GUEST_VARIANTS = { primary: "primary", secondary: "subtle", danger: "destructive" } as const;

function GuestButton({ tone, ...props }: GuestLinkButtonProps) {
  return <Button variant={GUEST_VARIANTS[tone]} size="dialog" {...props} />;
}

function GuestForm({ target }: { readonly target: GuestTarget }) {
  const model = useGuestLinks(target);

  return <GuestLinksForm model={model} Button={GuestButton} Input={Input} />;
}

/** A title's guest action appears only for people allowed to share from this session. */
export function TitleGuestLinks({
  title,
  phone = false,
}: {
  readonly title: Pick<TitleDetail, "id" | "name">;
  readonly phone?: boolean;
}) {
  const allowed = useMayShareGuests();

  return allowed ? <TitleGuestAction title={title} phone={phone} /> : null;
}

function TitleGuestAction({
  title,
  phone,
}: {
  readonly title: Pick<TitleDetail, "id" | "name">;
  readonly phone: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {phone ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
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
          onClick={() => setOpen(true)}
        >
          <LinkIcon aria-hidden />
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent title={`Share ${title.name}`}>
            <DialogBody>
              <GuestForm
                key={title.id}
                target={{
                  kind: "item",
                  item: { domain: "movies", ref: { type: "title", id: title.id } },
                }}
              />
            </DialogBody>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

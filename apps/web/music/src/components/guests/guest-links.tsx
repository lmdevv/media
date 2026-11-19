import { GuestLinksForm } from "@media/ui/components/guest-links-form";
import type { GuestLinkButtonProps } from "@media/ui/components/guest-links-form";
import type { GuestLinkSelection } from "@media/ui/lib/guest-link-dialog";
import { useGuestLinkDialog, useMayShareGuests } from "@media/ui/lib/use-guest-links";
import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

const GuestLinksContext = createContext<{
  readonly allowed: boolean;
  readonly show: (selection: GuestLinkSelection) => void;
} | null>(null);

function GuestButton({ tone, ...props }: GuestLinkButtonProps) {
  return <Button variant={tone} {...props} />;
}

/** Reads policy once for the signed-in page and keeps its dialog above transient song rows. */
export function GuestLinksProvider({ children }: { readonly children: ReactNode }) {
  const allowed = useMayShareGuests();
  const { selected, show, close } = useGuestLinkDialog(allowed);
  const value = useMemo(() => ({ allowed, show }), [allowed, show]);

  return (
    <GuestLinksContext value={value}>
      {children}
      {allowed && selected !== null ? (
        <GuestLinksForm target={selected.target} Button={GuestButton} Input={Input}>
          {(form, pending) => (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open && !pending) close();
              }}
            >
              <DialogContent title={`Share ${selected.name}`}>{form}</DialogContent>
            </Dialog>
          )}
        </GuestLinksForm>
      ) : null}
    </GuestLinksContext>
  );
}

/** Uses the page's already-loaded gate; a menu never starts its own policy query. */
export function GuestLinkMenuItem({ target, name }: GuestLinkSelection) {
  const sharing = useContext(GuestLinksContext);
  const [offered] = useState(sharing?.allowed ?? false);

  return offered && sharing !== null && sharing.allowed ? (
    <DropdownMenuItem onClick={() => sharing.show({ target, name })}>Guest link</DropdownMenuItem>
  ) : null;
}

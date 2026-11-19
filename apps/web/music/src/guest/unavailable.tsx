import { GuestUnavailable as SharedUnavailable } from "@media/ui/components/guest-unavailable";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";

const LeaveButton = (props: ComponentProps<"button">) => <Button variant="secondary" {...props} />;

/** The shared unavailable screen with music's own button. */
export function GuestUnavailable({ onLeave }: { readonly onLeave: () => Promise<void> }) {
  return <SharedUnavailable onLeave={onLeave} Button={LeaveButton} />;
}

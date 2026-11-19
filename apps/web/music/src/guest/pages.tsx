import type { GuestPages } from "@media/ui/components/guest-share";
import { GuestUnavailable } from "@media/ui/components/guest-unavailable";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { BlankPage, useSignOut } from "@/session/session";
import { UnreachableScreen } from "./unreachable";

const LeaveButton = (props: ComponentProps<"button">) => <Button variant="secondary" {...props} />;

function LinkUnavailable() {
  const leave = useSignOut();

  return <GuestUnavailable onLeave={leave} Button={LeaveButton} />;
}

/** Music's pages while a guest's read waits, is refused, or fails, with music's own buttons. */
export const guestPages: GuestPages = {
  Blank: BlankPage,
  Unavailable: LinkUnavailable,
  Unreachable: UnreachableScreen,
};

import type { GuestPages } from "@media/ui/components/guest-share";
import { GuestUnavailable } from "@media/ui/components/guest-unavailable";

import { useSignOut } from "@/session/session";
import { BlankPage } from "@/session/redirect";
import { UnreachableScreen } from "@/session/unreachable";

function LinkUnavailable() {
  const leave = useSignOut();

  return <GuestUnavailable onLeave={leave} />;
}

/** Movies' pages while a guest's read waits, is refused, or fails. */
export const guestPages: GuestPages = {
  Blank: BlankPage,
  Unavailable: LinkUnavailable,
  Unreachable: UnreachableScreen,
};

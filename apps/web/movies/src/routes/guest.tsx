import { GuestShare } from "@media/ui/components/guest-share";
import { createFileRoute, Navigate } from "@tanstack/react-router";

import { GuestItem } from "@/guest/item";
import { guestPages } from "@/guest/pages";
import { SoloSessionProvider } from "@/together/current-session";

export const Route = createFileRoute("/guest")({
  head: () => ({ meta: [{ title: "Shared with you · Lar Movies" }] }),
  component: GuestRoute,
});

function GuestRoute() {
  return (
    <SoloSessionProvider>
      <GuestShare domain="movies" pages={guestPages} home={<Navigate to="/" replace />}>
        {({ item, ...share }) => <GuestItem item={item.ref} {...share} />}
      </GuestShare>
    </SoloSessionProvider>
  );
}

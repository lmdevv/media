import { GuestShare } from "@media/ui/components/guest-share";
import { Navigate, createFileRoute } from "@tanstack/react-router";

import { GuestItem } from "@/guest/item";
import { guestPages } from "@/guest/pages";

export const Route = createFileRoute("/guest")({
  head: () => ({ meta: [{ title: "Shared with you · Lar Music" }] }),
  component: GuestRoute,
});

function GuestRoute() {
  return (
    <GuestShare domain="music" pages={guestPages} home={<Navigate to="/" replace />}>
      {({ item, ...share }) => <GuestItem item={item.ref} {...share} />}
    </GuestShare>
  );
}

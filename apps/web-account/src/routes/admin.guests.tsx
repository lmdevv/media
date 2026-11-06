import { createFileRoute } from "@tanstack/react-router";

import { GuestsScreen } from "@/components/admin/guests";

export const Route = createFileRoute("/admin/guests")({
  head: () => ({ meta: [{ title: "Guests · [media]" }] }),
  component: GuestsScreen,
});

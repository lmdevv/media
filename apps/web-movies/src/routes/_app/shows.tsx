import { createFileRoute } from "@tanstack/react-router";

import { TitleGridPage } from "@/components/browse/title-grid-page";

export const Route = createFileRoute("/_app/shows")({
  head: () => ({ meta: [{ title: "Shows · Lar Movies" }] }),
  component: () => <TitleGridPage kind="show" heading="Shows" />,
});

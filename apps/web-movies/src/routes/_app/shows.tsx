import { createFileRoute } from "@tanstack/react-router";

import { TitleGridPage } from "@/components/browse/title-grid-page";

export const Route = createFileRoute("/_app/shows")({
  head: () => ({ meta: [{ title: "Shows · [movies]" }] }),
  component: () => <TitleGridPage kind="show" heading="Shows" />,
});

import { createFileRoute } from "@tanstack/react-router";

import { TitleGridPage } from "@/components/browse/title-grid-page";

export const Route = createFileRoute("/_app/movies")({
  head: () => ({ meta: [{ title: "Movies · Lar Movies" }] }),
  component: () => <TitleGridPage kind="movie" heading="Movies" />,
});

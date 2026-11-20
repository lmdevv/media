import { createFileRoute } from "@tanstack/react-router";

import {
  TitleGridPage,
  GridPageSkeleton,
  preloadTitleGrid,
} from "@/components/browse/title-grid-page";

export const Route = createFileRoute("/_app/movies")({
  head: () => ({ meta: [{ title: "Movies · Lar Movies" }] }),
  loader: ({ context: { platform } }) => preloadTitleGrid(platform, { kind: "movie" }),
  pendingComponent: () => <GridPageSkeleton heading="Movies" />,
  component: () => <TitleGridPage kind="movie" heading="Movies" />,
});

import { createFileRoute } from "@tanstack/react-router";

import {
  TitleGridPage,
  GridPageSkeleton,
  preloadTitleGrid,
} from "@/components/browse/title-grid-page";

export const Route = createFileRoute("/_app/shows")({
  head: () => ({ meta: [{ title: "Shows · Lar Movies" }] }),
  loader: ({ context: { platform } }) => preloadTitleGrid(platform, { kind: "show" }),
  pendingComponent: () => <GridPageSkeleton heading="Shows" />,
  component: () => <TitleGridPage kind="show" heading="Shows" />,
});

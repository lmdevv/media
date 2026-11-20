import { createFileRoute } from "@tanstack/react-router";

import {
  TitleGridPage,
  TitleGridSkeleton,
  preloadTitleGrid,
} from "@/components/browse/title-grid-page";

export const Route = createFileRoute("/_app/shows")({
  head: () => ({ meta: [{ title: "Shows · Lar Movies" }] }),
  loader: ({ context: { platform } }) => preloadTitleGrid(platform, { kind: "show" }),
  pendingComponent: () => <TitleGridSkeleton heading="Shows" />,
  component: () => <TitleGridPage kind="show" heading="Shows" />,
});

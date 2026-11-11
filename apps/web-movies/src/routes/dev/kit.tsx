import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

const Gallery = import.meta.env.DEV
  ? lazy(() => import("@/dev/kit-gallery").then((module) => ({ default: module.KitGallery })))
  : undefined;

export const Route = createFileRoute("/dev/kit")({
  component: KitPage,
});

function KitPage() {
  if (Gallery === undefined) return null;

  return (
    <Suspense fallback={null}>
      <Gallery />
    </Suspense>
  );
}

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tile/$userId")({
  staticData: { intent: "tile" },
  head: () => ({ meta: [{ title: "Unlock · Lar" }] }),
  component: () => null,
});

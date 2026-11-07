import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/add")({
  staticData: { intent: "add" },
  head: () => ({ meta: [{ title: "Add someone · [media]" }] }),
  component: () => null,
});

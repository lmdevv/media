import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  staticData: { intent: "picker" },
  head: () => ({ meta: [{ title: "Who's here? · [media]" }] }),
  component: () => null,
});

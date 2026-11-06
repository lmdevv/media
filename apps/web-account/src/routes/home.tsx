import { createFileRoute } from "@tanstack/react-router";

import { Shell } from "@/components/shell";
import { HomeView } from "@/screens/people/home";
import { useMe } from "@/session/me";

export const Route = createFileRoute("/home")({
  head: () => ({ meta: [{ title: "[media]" }] }),
  component: HomePage,
});

function HomePage() {
  const me = useMe();

  return (
    <Shell>
      <HomeView me={me} />
    </Shell>
  );
}

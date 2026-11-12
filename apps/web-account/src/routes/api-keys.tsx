import { createFileRoute } from "@tanstack/react-router";

import { SettingsFrame } from "@/components/shell";
import { ApiKeysScreen } from "@/screens/people/credentials";

export const Route = createFileRoute("/api-keys")({
  staticData: { need: "account" },
  head: () => ({ meta: [{ title: "API keys · [media]" }] }),
  component: () => (
    <SettingsFrame>
      <ApiKeysScreen />
    </SettingsFrame>
  ),
});

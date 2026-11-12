import { createFileRoute } from "@tanstack/react-router";

import { SettingsFrame } from "@/components/shell";
import { DevicesScreen } from "@/screens/people/credentials";

export const Route = createFileRoute("/devices")({
  staticData: { need: "account" },
  head: () => ({ meta: [{ title: "Devices · [media]" }] }),
  component: () => (
    <SettingsFrame>
      <DevicesScreen />
    </SettingsFrame>
  ),
});

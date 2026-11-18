import { Stack } from "expo-router";

import { ImportProvider } from "@/components/owner/import-state";

export default function ImportLayout() {
  return (
    <ImportProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </ImportProvider>
  );
}

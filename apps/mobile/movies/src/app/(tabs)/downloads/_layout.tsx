import { Stack } from "expo-router";

import { useTabStackOptions } from "@/components/browse/tab-stack";

export default function DownloadsLayout() {
  const options = useTabStackOptions();

  return (
    <Stack screenOptions={options}>
      <Stack.Screen name="index" options={{ title: "Downloads" }} />
    </Stack>
  );
}

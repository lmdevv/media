/**
 * The Search tab's stack, so the screen gets the native header with a large title and the system
 * search field, which iOS moves into the tab bar for the search tab (E00–E05).
 */
import { Stack } from "expo-router";

import { useTabStackOptions } from "@/components/browse/tab-stack";

export default function SearchLayout() {
  const options = useTabStackOptions();

  return (
    <Stack screenOptions={options}>
      <Stack.Screen name="index" options={{ title: "Search" }} />
    </Stack>
  );
}

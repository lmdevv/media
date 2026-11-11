import { View } from "react-native";

import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";

const LICENSES: ReadonlyArray<{ readonly name: string; readonly license: string }> = [
  { name: "[movies]", license: "MIT" },
  { name: "React Native and Expo", license: "MIT" },
  { name: "Effect", license: "MIT" },
  { name: "Convex", license: "Apache 2.0" },
  { name: "Lucide icons", license: "ISC" },
  { name: "Inter Tight", license: "SIL Open Font License 1.1" },
  { name: "Geist Mono", license: "SIL Open Font License 1.1" },
  { name: "Sintel, © Blender Foundation", license: "CC BY 3.0" },
];

export default function Licenses() {
  return (
    <Screen
      readable
      scroll
      header={<NavHeader title="Open Source Licenses" fallback="/settings/about" />}
    >
      {LICENSES.map((entry) => (
        <View key={entry.name} accessible className="min-h-14 justify-center gap-0.5">
          <Text>{entry.name}</Text>
          <Text variant="meta" tone="muted">
            {entry.license}
          </Text>
        </View>
      ))}
    </Screen>
  );
}

import { useState } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { ContentWidthContext } from "@/lib/window-layout";

export function ContentArea({
  framed,
  children,
}: {
  /** Whether a sidebar and a bar frame the area, rather than the system's tab bar. */
  readonly framed: boolean;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const [width, setWidth] = useState<number | null>(null);

  return (
    <View
      className={`flex-1 ${framed ? "overflow-hidden dark:mx-2 dark:rounded-mobile-card" : ""}`}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <SafeAreaInsetsContext value={framed ? { ...insets, top: 0, bottom: 0 } : insets}>
        <ContentWidthContext value={width}>{children}</ContentWidthContext>
      </SafeAreaInsetsContext>
    </View>
  );
}

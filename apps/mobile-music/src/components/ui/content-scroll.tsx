import { requireNativeView } from "expo";
import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import type { ViewProps } from "react-native";

const NativeContentScroll = requireNativeView<ViewProps>("ContentScroll");

const styles = StyleSheet.create({ page: { flex: 1 } });

/** Fills the page and names the scroll view among `children` as its content. */
export function ContentScroll({ children }: { readonly children: ReactNode }) {
  return <NativeContentScroll style={styles.page}>{children}</NativeContentScroll>;
}

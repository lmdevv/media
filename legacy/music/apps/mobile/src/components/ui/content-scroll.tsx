/**
 * The root of every page in the tabs. iOS minimizes the tab bar and moves the mini player inline
 * as the page's content scrolls (A14, A15, A17), but finds that content by guessing, and misses a
 * list under a floating bar or a hero. `modules/content-scroll` names the first scroll view inside
 * this view as the page's content instead, so every page that scrolls morphs the bar, not only
 * Home.
 */
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

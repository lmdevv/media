import type { ReactNode } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Edge } from "react-native-safe-area-context";

/**
 * The readable column on an iPad: at most `--container-readable` wide, centered, with no gutter of
 * its own. Put it on the content of a list a screen scrolls itself, so the list still scrolls from
 * the margins; an iPhone keeps its full-width layout.
 */
export const READABLE_COLUMN =
  "regular:w-full regular:max-w-readable regular:self-center regular:px-0";

/** Props for `Screen`. */
export interface ScreenProps {
  readonly children: ReactNode;
  /** Scrolls the content and avoids the keyboard, for forms. */
  readonly scroll?: boolean;
  /**
   * Keeps the header and the content in the readable column on an iPad, for forms, lists, and
   * settings. Media pages, grids, and the player leave it off and fill the window.
   */
  readonly readable?: boolean;
  readonly edges?: ReadonlyArray<Edge>;
  readonly header?: ReactNode;
  readonly contentClassName?: string;
}

/** A full-screen page. */
export function Screen({
  children,
  scroll = false,
  readable = false,
  edges = ["top", "bottom"],
  header,
  contentClassName,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const column = readable ? READABLE_COLUMN : "";

  return (
    <View
      className="flex-1 bg-bg"
      style={{
        paddingTop: edges.includes("top") ? insets.top : 0,
        paddingBottom: edges.includes("bottom") ? insets.bottom : 0,
      }}
    >
      {header === undefined || header === null ? null : (
        <View className={`px-5 ${column}`}>{header}</View>
      )}
      {scroll ? (
        <KeyboardAvoidingView behavior="padding" className="flex-1">
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            contentContainerClassName={`grow px-5 py-4 gap-4 ${column} ${contentClassName ?? ""}`}
          >
            {children}
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <View className={`flex-1 ${column} ${contentClassName ?? ""}`}>{children}</View>
      )}
    </View>
  );
}

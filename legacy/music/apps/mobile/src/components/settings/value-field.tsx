/**
 * A field that shows a value instead of taking one: a new API key (F06), an invite link (F11), a
 * reset link (F23). It looks like Paper's filled field; the text is selectable so it can be copied
 * by hand too.
 */
import { View } from "react-native";

import { Text } from "@/components/ui/text";

/** Props for `ValueField`. */
export interface ValueFieldProps {
  readonly label: string;
  readonly value: string;
  readonly helper?: string;
  /** Long links stay on one line, cut in the middle; secrets wrap so every character shows. */
  readonly wrap?: boolean;
}

/** A labeled, read-only value on Paper's field surface. */
export function ValueField({ label, value, helper, wrap = false }: ValueFieldProps) {
  return (
    <View className="gap-2 pt-4">
      <Text variant="label">{label}</Text>
      <View className="min-h-row-touch justify-center rounded-lg bg-surface p-4">
        <Text selectable numberOfLines={wrap ? undefined : 1} ellipsizeMode="middle">
          {value}
        </Text>
      </View>
      {helper === undefined ? null : (
        <Text variant="secondary" tone="muted">
          {helper}
        </Text>
      )}
    </View>
  );
}

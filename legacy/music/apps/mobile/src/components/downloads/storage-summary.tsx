/**
 * The storage summary over a Downloaded list (D10, D10c): a mono count and the space it takes on one
 * baseline, then a muted sentence.
 */
import { View } from "react-native";

import { Text } from "@/components/ui/text";
import { formatBytes } from "@/lib/format";

/** `line` beside `bytes`, over `note`; no size while nothing takes space. */
export function StorageSummary({
  line,
  bytes,
  note,
}: {
  readonly line: string;
  readonly bytes: number;
  readonly note: string;
}) {
  return (
    <View className="gap-2 pt-1 pb-3">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text variant="mono" tone="muted" className="shrink">
          {line}
        </Text>
        {bytes === 0 ? null : <Text variant="mono">{formatBytes(bytes)}</Text>}
      </View>
      <Text variant="secondary" tone="muted">
        {note}
      </Text>
    </View>
  );
}

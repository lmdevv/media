import { Folder } from "lucide-react-native";
import { View } from "react-native";

import { ListRow } from "@/components/ui/list-row";
import { ProgressBar } from "@/components/ui/progress-bar";

import type { ActiveScan, Scan } from "./libraries";

const progressOf = (scan: Scan): { readonly detail: string; readonly value: number } | null => {
  const { done, total } = scan;

  if (done === null || total === null || total <= 0) return null;

  return { detail: `${done} of ${total}`, value: Math.min(1, done / total) };
};

/** One row per scanning library, with counts when the core shares them with this person. */
export function ScanStatus({ scans }: { readonly scans: ReadonlyArray<ActiveScan> }) {
  return (
    <View className="gap-4 px-5 regular:px-8 wide:px-12">
      {scans.map(({ library, scan }) => {
        const progress = progressOf(scan);
        const title = `Scanning ${library.name}`;

        return (
          <View key={library.libraryId} className="gap-4">
            {progress === null ? (
              <ListRow icon={Folder} title={title} />
            ) : (
              <ListRow icon={Folder} title={title} detail={progress.detail} />
            )}
            {progress === null ? null : <ProgressBar value={progress.value} />}
          </View>
        );
      })}
    </View>
  );
}

import { View } from "react-native";

import { Row } from "@/components/ui/row";
import type { DownloadedLine } from "@/lib/downloaded";
import { formatBytes } from "@/lib/format";

import { TrackDownloadGlyph } from "./download-glyphs";
import { RemovableRow } from "./removable-row";

/** An album, a playlist, a song, or the songs downloaded on their own. */
export function DownloadedRow({
  title,
  line,
  artUri,
  recyclingKey,
  bytes,
  active = false,
  onPress,
  onRemove,
}: {
  readonly title: string;
  readonly line: DownloadedLine;
  readonly artUri: string | null;
  readonly recyclingKey: string;
  readonly bytes: number;
  readonly active?: boolean;
  readonly onPress: () => void;
  /** Opens the Remove download sheet; none for the Songs row. */
  readonly onRemove?: (() => void) | undefined;
}) {
  const size = bytes > 0 ? formatBytes(bytes) : null;

  const label = [title, line.text, size].filter((part) => part !== null).join(", ");

  return (
    <RemovableRow label={label} resetKey={recyclingKey} onPress={onPress} onRemove={onRemove}>
      {(press) => (
        <View className="px-page">
          <Row
            title={title}
            subtitle={line.text}
            subtitleTone={line.tone}
            subtitleGlyph={
              line.glyph === null ? undefined : <TrackDownloadGlyph state={line.glyph} />
            }
            leading={{ kind: "art", url: artUri, recyclingKey }}
            detail={{ text: size ?? "", variant: "mono" }}
            active={active}
            accessibilityLabel={label}
            {...press}
          />
        </View>
      )}
    </RemovableRow>
  );
}

/**
 * A song this phone holds, read from the downloads rather than the server (D10's Songs, and an
 * album or playlist opened with no server): its cover from this phone, the downloaded glyph, and
 * no song actions, which need the server; Downloaded can still remove its own download.
 */
import type { LocalCopy } from "@music/sdk/downloads";
import { View } from "react-native";

import { Row } from "@/components/ui/row";
import { formatBytes } from "@/lib/format";

import { TrackDownloadGlyph } from "./download-glyphs";
import { RemovableRow } from "./removable-row";

/** One downloaded song; it plays on tap. */
export function LocalSongRow({
  copy,
  active,
  showSize = false,
  onPress,
  onRemove,
}: {
  readonly copy: LocalCopy;
  readonly active: boolean;
  /** D10 lists the space each song takes. */
  readonly showSize?: boolean;
  readonly onPress: () => void;
  /** Opens the Remove download sheet; Downloaded gives it only to a song downloaded on its own. */
  readonly onRemove?: (() => void) | undefined;
}) {
  const { title, artist } = copy.track;

  return (
    <RemovableRow
      label={`${title}, ${artist}`}
      resetKey={copy.track.id}
      onPress={onPress}
      onRemove={onRemove}
    >
      {(press) => (
        <View className="px-mobile-edge">
          <Row
            title={title}
            subtitle={artist}
            subtitleGlyph={<TrackDownloadGlyph state="downloaded" />}
            leading={{ kind: "art", url: copy.artUri, recyclingKey: copy.track.id }}
            detail={showSize ? { text: formatBytes(copy.bytes), variant: "mono" } : undefined}
            active={active}
            {...press}
          />
        </View>
      )}
    </RemovableRow>
  );
}

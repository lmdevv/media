/**
 * A song this phone holds, read from the downloads rather than the server (D10's Songs, and an
 * album or playlist opened with no server): its cover from this phone, the downloaded glyph, and
 * no actions, which need the server.
 */
import type { LocalCopy } from "@music/sdk/downloads";
import { View } from "react-native";

import { Row } from "@/components/ui/row";
import { formatBytes } from "@/lib/format";

import { TrackDownloadGlyph } from "./download-glyphs";

/** One downloaded song; it plays on tap. */
export function LocalSongRow({
  copy,
  active,
  showSize = false,
  onPress,
}: {
  readonly copy: LocalCopy;
  readonly active: boolean;
  /** D10 lists the space each song takes. */
  readonly showSize?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <View className="px-mobile-edge">
      <Row
        title={copy.track.title}
        subtitle={copy.track.artist}
        subtitleGlyph={<TrackDownloadGlyph state="downloaded" />}
        leading={{ kind: "art", url: copy.artUri, recyclingKey: copy.track.id }}
        detail={showSize ? { text: formatBytes(copy.bytes), variant: "mono" } : undefined}
        active={active}
        onPress={onPress}
      />
    </View>
  );
}

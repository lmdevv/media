import type { TrackId } from "@music/commands/ids";

import type { RowProps } from "@/components/ui/row";
import { useTrackDownload, useTrackReachable } from "@/downloads";

import { TrackDownloadGlyph } from "./download-glyphs";

const SPOKEN = {
  queued: "Waiting to download",
  downloading: "Downloading",
  downloaded: "Downloaded",
} as const;

/** The parts of a song row its download changes. */
type SongDownloadLine = Pick<
  RowProps,
  "subtitle" | "subtitleTone" | "subtitleGlyph" | "onPress" | "accessibilityLabel" | "dimmed"
>;

/** The subtitle, glyph, and press of the row for `trackId`, null for a song that isn't one. */
export const useSongDownloadLine = (
  trackId: TrackId | null,
  title: string,
  subtitle: string,
  onPress: (() => void) | undefined,
): SongDownloadLine => {
  const { state, retry } = useTrackDownload(trackId);
  const reachable = useTrackReachable(trackId);

  if (onPress !== undefined && !reachable) {
    return { subtitle: "Not downloaded", onPress: undefined, dimmed: true };
  }

  if (state === "none") return { subtitle, onPress };

  if (state === "failed") {
    if (onPress === undefined) return { subtitle, onPress };
    const play = onPress;

    return {
      subtitle: "Couldn’t download · Tap to retry",
      subtitleTone: "danger",
      subtitleGlyph: <TrackDownloadGlyph state={state} />,
      onPress: () => {
        retry();
        play();
      },
    };
  }

  return {
    subtitle,
    subtitleGlyph: <TrackDownloadGlyph state={state} />,
    onPress,
    accessibilityLabel: `${title}, ${SPOKEN[state]}, ${subtitle}`,
  };
};

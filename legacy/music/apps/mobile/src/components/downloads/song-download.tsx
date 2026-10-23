/**
 * A song row's download state (Paper's D01, D05, D06): a 12pt glyph before the subtitle while this
 * phone holds or is getting the song, and, once it failed, "Couldn’t download · Tap to retry" in
 * danger. Tapping a failed song tries it again and still plays it, since it streams while online.
 * While the server is out of reach, a song this phone doesn't hold dims, says "Not downloaded",
 * and doesn't play (D13).
 */
import type { TrackId } from "@music/commands/ids";

import type { RowProps } from "@/components/ui/row";
import { useTrackDownload, useTrackReachable } from "@/downloads";

import { TrackDownloadGlyph } from "./download-glyphs";

/** What VoiceOver adds after the title; a failed song's subtitle already says it. */
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

  // A row that can't play for its own reason, such as a missing file, keeps saying so.
  if (onPress !== undefined && !reachable) {
    return { subtitle: "Not downloaded", onPress: undefined, dimmed: true };
  }

  if (state === "none") return { subtitle, onPress };

  if (state === "failed") {
    // A song that can't play here has nothing to retry either.
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

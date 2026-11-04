import { BITMAP_SUBTITLE_FORMATS } from "@media/contracts/media-playback";
import type { SubtitleTrack } from "@media/contracts/media-playback";
import type { AudioStream } from "@media/contracts/models/catalog";

import { languageName } from "../languages";

const channelsLabel = (channels: number): string | null => {
  if (channels <= 0) return null;

  if (channels === 1) return "Mono";

  if (channels === 2) return "Stereo";

  if (channels === 6) return "5.1";

  if (channels === 8) return "7.1";

  return `${String(channels)} ch`;
};

const distinct = (labels: ReadonlyArray<string>): ReadonlyArray<string> =>
  labels.map((label, index) =>
    labels.filter((other) => other === label).length > 1
      ? `${label} (${String(index + 1)})`
      : label,
  );

const audioLabel = (
  track: Pick<AudioStream, "language" | "title" | "channels">,
  position: number,
): string => {
  const language = languageName(track.language);
  const title = track.title?.trim() ?? "";

  if (language === null) {
    return [title === "" ? `Track ${String(position + 1)}` : title, channelsLabel(track.channels)]
      .filter((part) => part !== null)
      .join(" · ");
  }

  return [language, title === "" ? channelsLabel(track.channels) : title]
    .filter((part) => part !== null)
    .join(" · ");
};

/** Names for a file's audio tracks, by position. */
export const audioTrackLabels = (
  tracks: ReadonlyArray<Pick<AudioStream, "language" | "title" | "channels">>,
): ReadonlyArray<string> => distinct(tracks.map(audioLabel));

const subtitleLabel = (
  track: Pick<
    SubtitleTrack,
    "language" | "title" | "hearingImpaired" | "forced" | "kind" | "codec"
  >,
  position: number,
): string => {
  const language = languageName(track.language);
  const title = track.title?.trim() ?? "";
  const name = language ?? (title === "" ? `Subtitles ${String(position + 1)}` : title);

  const distinctTitle =
    language !== null && title !== "" && !title.toLowerCase().includes(language.toLowerCase());

  const flags = [
    track.hearingImpaired ? "SDH" : null,
    track.forced ? "Forced" : null,
    distinctTitle && !track.hearingImpaired && !track.forced ? title : null,
    track.kind === "bitmap" ? (BITMAP_SUBTITLE_FORMATS.get(track.codec) ?? "Image") : null,
  ].filter((flag) => flag !== null);

  return [name, ...flags].join(" · ");
};

/** Names for a stream's subtitle tracks, by position. */
export const subtitleTrackLabels = (
  tracks: ReadonlyArray<
    Pick<SubtitleTrack, "language" | "title" | "hearingImpaired" | "forced" | "kind" | "codec">
  >,
): ReadonlyArray<string> => distinct(tracks.map(subtitleLabel));

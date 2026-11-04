import { BITMAP_SUBTITLE_FORMATS, type SubtitleTrack } from "@media/contracts/media-playback";
import type { AudioStream, MediaFile } from "@media/contracts/models/catalog";
import { MediaLabels } from "@media/sdk/effect";

const { channelLabel, codecLabel, hdrLabel, resolutionLabel } = MediaLabels;

const displayNames = new Intl.DisplayNames(["en"], { type: "language" });

const languageName = (code: string | null): string | null => {
  if (code === null || code === "" || code === "und") return null;

  try {
    const name = displayNames.of(code);

    return name === undefined || name === code ? null : name;
  } catch {
    return null;
  }
};

/** An audio track as the track chooser lists it: `English 5.1`, or its title, or `Track 2`. */
export const audioTrackLabel = (
  track: Pick<AudioStream, "language" | "title" | "channels">,
  position: number,
): string => {
  const name = languageName(track.language) ?? track.title ?? `Track ${position + 1}`;

  return [name, channelLabel(track.channels)].filter((part) => part !== null).join(" ");
};

const pictureFormat = (kind: string, codec: string): string | null =>
  kind === "bitmap" || kind === "image" ? (BITMAP_SUBTITLE_FORMATS.get(codec) ?? "image") : null;

/**
 * A subtitle track as the chooser lists it: `English`, `English CC`, `English (Forced)`, and, for a
 * picture track that is drawn into the video, its format: `English (PGS)`, `English (Forced,
 * VobSub)`. `position` is the track's place in the whole list, for tracks with no name.
 */
export const subtitleTrackLabel = (
  track: Pick<
    SubtitleTrack,
    "language" | "title" | "hearingImpaired" | "forced" | "kind" | "codec"
  >,
  position: number,
): string => {
  const name = languageName(track.language ?? null) ?? track.title ?? `Subtitles ${position + 1}`;
  const base = track.hearingImpaired ? `${name} CC` : name;

  const flags = [track.forced ? "Forced" : null, pictureFormat(track.kind, track.codec)].filter(
    (flag) => flag !== null,
  );

  return flags.length === 0 ? base : `${base} (${flags.join(", ")})`;
};

const repeated = (labels: ReadonlyArray<string>, label: string): boolean =>
  labels.filter((each) => each === label).length > 1;

/**
 * Labels for a file's whole subtitle list, by position, so every surface names a track the same
 * way. Two tracks that would read the same get their titles (`English (PGS) · Commentary`), and
 * then their positions.
 */
export const subtitleTrackLabels = (
  tracks: ReadonlyArray<
    Pick<SubtitleTrack, "language" | "title" | "hearingImpaired" | "forced" | "kind" | "codec">
  >,
): ReadonlyArray<string> => {
  const plain = tracks.map(subtitleTrackLabel);

  const titled = plain.map((label, index) => {
    const title = tracks[index]?.title;

    return repeated(plain, label) && title !== undefined && !label.includes(title)
      ? `${label} · ${title}`
      : label;
  });

  return distinct(titled);
};

const distinct = (labels: ReadonlyArray<string>): ReadonlyArray<string> =>
  labels.some((label) => repeated(labels, label))
    ? distinct(
        labels.map((label, index) =>
          repeated(labels, label) ? `${label} · ${String(index + 1)}` : label,
        ),
      )
    : labels;

/** The badges Paper draws after a title's facts, in order: resolution, HDR, codec, audio, CC. */
export const fileBadges = (file: MediaFile): ReadonlyArray<string> => {
  const video = file.probe.video[0];
  const audio = file.probe.audio.find((track) => track.default) ?? file.probe.audio[0];
  const subtitled = file.probe.subtitles.length > 0 || file.externalSubtitles.length > 0;

  const badges = [
    video === undefined ? null : resolutionLabel(video.width, video.height),
    video === undefined ? null : hdrLabel(video.hdr),
    video === undefined ? null : codecLabel(video.codec),
    audio === undefined
      ? null
      : [codecLabel(audio.codec), channelLabel(audio.channels)]
          .filter((part) => part !== null)
          .join(" "),
    subtitled ? "CC" : null,
  ];

  return badges.filter((badge): badge is string => badge !== null && badge !== "");
};

/** `English EAC3 5.1, Spanish · English CC, Español`: audio tracks, then subtitle languages. */
export const trackSummary = (file: MediaFile): string | null => {
  const audio = file.probe.audio.map((track) =>
    [
      languageName(track.language) ?? track.title,
      codecLabel(track.codec),
      channelLabel(track.channels),
    ]
      .filter((part) => part !== null && part !== "")
      .join(" "),
  );

  const subtitles = [
    ...file.probe.subtitles.map((track) => {
      const name = languageName(track.language) ?? track.title;
      const format = pictureFormat(track.kind, track.codec);

      return name === null || format === null ? name : `${name} (${format})`;
    }),
    ...file.externalSubtitles.map((track) => languageName(track.language)),
  ].filter((name): name is string => name !== null && name !== "");

  const parts = [audio.join(", "), [...new Set(subtitles)].join(", ")].filter(
    (part) => part !== "",
  );

  return parts.length === 0 ? null : parts.join(" · ");
};

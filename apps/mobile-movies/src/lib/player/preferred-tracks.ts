import type { SubtitleTrack } from "@media/contracts/media-playback";

import type { AudioStream } from "../catalog";
import { isLanguage } from "../languages";
import type { PlaybackPreferences } from "../preferences";

/** The tracks to switch to; null keeps what the stream chose. */
export interface PreferredTracks {
  readonly audioStreamIndex: number | null;
  readonly subtitleId: string | null;
}

const DESCRIPTION = /audio description|descriptive/iu;

const DESCRIPTION_ABBREVIATION = /\bAD\b/u;

const describes = (title: string | null): boolean =>
  title !== null && (DESCRIPTION.test(title) || DESCRIPTION_ABBREVIATION.test(title));

const best = <A>(items: ReadonlyArray<A>, score: (item: A) => number): A | null =>
  items.reduce<A | null>(
    (chosen, item) => (chosen === null || score(item) > score(chosen) ? item : chosen),
    null,
  );

/** The tracks to play for `preferences` among a file's audio and a stream's subtitles. */
export const preferredTracks = (
  preferences: Pick<
    PlaybackPreferences,
    "audioLanguage" | "audioDescription" | "subtitleLanguage" | "subtitlesSdh"
  >,
  audio: ReadonlyArray<Pick<AudioStream, "index" | "language" | "title" | "default">>,
  subtitles: ReadonlyArray<
    Pick<SubtitleTrack, "id" | "language" | "forced" | "hearingImpaired" | "kind">
  >,
): PreferredTracks => {
  const { audioLanguage, audioDescription, subtitleLanguage, subtitlesSdh } = preferences;
  const fallback = audio.find((track) => track.default) ?? audio[0];

  const audioChoices =
    audioLanguage !== null
      ? audio.filter((track) => isLanguage(track.language, audioLanguage))
      : audioDescription
        ? audio.filter((track) => track.language === fallback?.language)
        : [];

  const audioTrack = best(
    audioChoices,
    (track) => (describes(track.title) === audioDescription ? 2 : 0) + (track.default ? 1 : 0),
  );

  const subtitleTrack =
    subtitleLanguage === null
      ? null
      : best(
          subtitles.filter(
            (track) => !track.forced && isLanguage(track.language, subtitleLanguage),
          ),
          (track) =>
            (track.hearingImpaired === subtitlesSdh ? 2 : 0) + (track.kind === "text" ? 1 : 0),
        );

  return {
    audioStreamIndex: audioTrack?.index ?? null,
    subtitleId: subtitleTrack?.id ?? null,
  };
};

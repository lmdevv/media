import type { PlaybackQuality } from "@media/contracts/media-playback";
import { Schema } from "effect";

/** A quality the viewer can choose. */
export const QualityChoice = Schema.Literals(["auto", "original", "1080p", "720p", "480p"]);

/** A quality the viewer can choose. */
export type QualityChoice = typeof QualityChoice.Type;

/** The choices in menu order, with their labels. */
export const QUALITY_OPTIONS: ReadonlyArray<{
  readonly id: QualityChoice;
  readonly label: string;
}> = [
  { id: "auto", label: "Auto" },
  { id: "original", label: "Original" },
  { id: "1080p", label: "1080p" },
  { id: "720p", label: "720p" },
  { id: "480p", label: "480p" },
];

const CAPS: Readonly<Record<QualityChoice, PlaybackQuality | undefined>> = {
  auto: undefined,
  original: undefined,
  "1080p": { maxHeight: 1080, maxBitrate: 10_000_000 },
  "720p": { maxHeight: 720, maxBitrate: 4_000_000 },
  "480p": { maxHeight: 480, maxBitrate: 2_000_000 },
};

/** The cap to negotiate with for `choice`; none for `auto` and `original`. */
export const qualityCap = (choice: QualityChoice): PlaybackQuality | undefined => CAPS[choice];

const isChoice = Schema.is(QualityChoice);

/** The choice an option ID names, or undefined for anything else. */
export const parseQualityChoice = (id: string): QualityChoice | undefined =>
  isChoice(id) ? id : undefined;

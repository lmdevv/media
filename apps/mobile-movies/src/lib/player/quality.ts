import type { PlaybackQuality } from "@media/contracts/media-playback";

/** A quality the viewer can choose. */
export type QualityChoice = "auto" | "1080p" | "720p" | "480p";

/** One row of the quality menu. */
export interface QualityOption {
  readonly id: QualityChoice;
  readonly label: string;
  /** The rate the service encodes at this height, such as `8 Mbps`; null for Auto. */
  readonly rate: string | null;
  /** The cap to negotiate with; null for Auto. */
  readonly cap: PlaybackQuality | null;
}

/** The choices in menu order. */
export const QUALITY_OPTIONS: ReadonlyArray<QualityOption> = [
  { id: "auto", label: "Auto", rate: null, cap: null },
  { id: "1080p", label: "1080p", rate: "8 Mbps", cap: { maxHeight: 1080, maxBitrate: 10_000_000 } },
  { id: "720p", label: "720p", rate: "4 Mbps", cap: { maxHeight: 720, maxBitrate: 4_000_000 } },
  { id: "480p", label: "480p", rate: "2 Mbps", cap: { maxHeight: 480, maxBitrate: 2_000_000 } },
];

/** The cap to negotiate with for `choice`; null for Auto. */
export const qualityCap = (choice: QualityChoice): PlaybackQuality | null =>
  QUALITY_OPTIONS.find((option) => option.id === choice)?.cap ?? null;

/**
 * The next choice below a picture `height` lines tall, for Try Lower Quality after playback was
 * interrupted; null when nothing is lower.
 */
export const lowerQuality = (height: number): QualityChoice | null =>
  QUALITY_OPTIONS.find(
    (option) => option.cap?.maxHeight !== undefined && option.cap.maxHeight < height,
  )?.id ?? null;

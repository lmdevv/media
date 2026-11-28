import type { PlatformSdk } from "@media/sdk/promise";

type CoreSettings = Awaited<ReturnType<PlatformSdk["core"]["settings"]["get"]>>;

/**
 * How large a download may be, the person's `downloadQuality` on this device in the core's
 * settings: `standard` up to 720p, `high` up to 1080p.
 */
export type DownloadQuality = NonNullable<CoreSettings["device"]>["downloadQuality"];

/** The Video Quality choices in menu order (H18's sheet). */
export const DOWNLOAD_QUALITY_OPTIONS: ReadonlyArray<{
  readonly id: DownloadQuality;
  readonly label: string;
  /** The muted note beside a choice that is not selected. */
  readonly note: string | null;
}> = [
  { id: "standard", label: "Standard", note: null },
  { id: "high", label: "High", note: "Larger Files" },
];

/** The label of `quality`, such as `Standard`. */
export const qualityLabel = (quality: DownloadQuality): string =>
  DOWNLOAD_QUALITY_OPTIONS.find((option) => option.id === quality)?.label ?? "Standard";

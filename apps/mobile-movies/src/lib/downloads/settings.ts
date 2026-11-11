import type { PlatformSdk } from "@media/sdk/promise";
import { Effect, Option, Schema } from "effect";

type CoreSettings = Awaited<ReturnType<PlatformSdk["core"]["settings"]["get"]>>;

/**
 * How large a download may be, the person's `downloadQuality` on this device in the core's
 * settings: `standard` up to 720p, `high` up to 1080p.
 */
export type DownloadQuality = NonNullable<CoreSettings["device"]>["downloadQuality"];

/** The Download Settings this iPhone keeps for itself. */
export interface DownloadSettings {
  /** Transfers only on Wi-Fi; on mobile data downloads wait (`Waiting for Wi-Fi`). */
  readonly wifiOnly: boolean;
}

/** Settings before anyone changed them: Wi-Fi only. */
export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = { wifiOnly: true };

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

const Stored = Schema.fromJsonString(
  Schema.Struct({
    wifiOnly: Schema.optionalKey(
      Schema.Boolean.pipe(
        Schema.catchDecoding(() => Effect.succeedSome(DEFAULT_DOWNLOAD_SETTINGS.wifiOnly)),
      ),
    ),
  }),
);

const decodeStored = Schema.decodeUnknownOption(Stored);

/** The settings kept in `text`, with defaults for anything missing or unreadable. */
export const parseDownloadSettings = (text: string | null): DownloadSettings => ({
  ...DEFAULT_DOWNLOAD_SETTINGS,
  ...Option.getOrElse(decodeStored(text), () => ({})),
});

/** The settings as the JSON they are kept as. */
export const serializeDownloadSettings = (settings: DownloadSettings): string =>
  JSON.stringify({ wifiOnly: settings.wifiOnly });

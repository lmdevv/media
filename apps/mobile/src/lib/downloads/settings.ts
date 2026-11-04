import { DownloadQuality } from "@media/contracts/media-playback";
import { Effect, Option, Schema } from "effect";

/** Download Settings. */
export interface DownloadSettings {
  /** Transfers only on Wi-Fi; on mobile data downloads wait (`Waiting for Wi-Fi`). */
  readonly wifiOnly: boolean;
  readonly quality: DownloadQuality;
}

/** Settings before anyone changed them: Wi-Fi only, Standard quality. */
export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = { wifiOnly: true, quality: "standard" };

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

const orElse = <S extends Schema.Top>(schema: S, fallback: S["Type"]) =>
  Schema.optionalKey(schema.pipe(Schema.catchDecoding(() => Effect.succeedSome(fallback))));

const Stored = Schema.fromJsonString(
  Schema.Struct({
    wifiOnly: orElse(Schema.Boolean, DEFAULT_DOWNLOAD_SETTINGS.wifiOnly),
    quality: orElse(DownloadQuality, DEFAULT_DOWNLOAD_SETTINGS.quality),
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
  JSON.stringify({ wifiOnly: settings.wifiOnly, quality: settings.quality });

import type { PlatformSdk } from "@media/sdk/promise";
import { Effect, Option, Schema } from "effect";

import { LANGUAGES, languageName } from "./languages";
import { QUALITY_OPTIONS as PLAYER_QUALITY_OPTIONS } from "./player/quality";
import type { QualityChoice } from "./player/quality";

const StreamingQuality = Schema.Literals([
  "auto",
  "1080p",
  "720p",
  "480p",
] as const satisfies ReadonlyArray<QualityChoice>);

/** A streaming quality cap. */
export type StreamingQuality = typeof StreamingQuality.Type;

const MobileData = Schema.Literals(["askFirst", "allowStreaming", "wifiOnly"]);

/** A mobile data choice. */
export type MobileData = typeof MobileData.Type;

const LanguageCode = Schema.String.check(Schema.isPattern(/^[a-z]{2}$/u));

/** The playback preferences. The person's settings on the server hold the `SyncedPreferences`. */
export interface PlaybackPreferences {
  readonly quality: StreamingQuality;
  readonly mobileData: MobileData;
  /** The audio language to choose when a file has it; null plays the file's default track. */
  readonly audioLanguage: string | null;
  /** The subtitle language to show when a file has it; null leaves subtitles off. */
  readonly subtitleLanguage: string | null;
  /** Prefers subtitles for the deaf and hard of hearing (SDH) in the subtitle language. */
  readonly subtitlesSdh: boolean;
  /** Prefers audio description tracks in the audio language. */
  readonly audioDescription: boolean;
  /** Plays the next episode when one ends, after the next-episode countdown. */
  readonly autoplayNext: boolean;
}

/** Preferences before anyone changed them. */
export const DEFAULT_PREFERENCES: PlaybackPreferences = {
  quality: "auto",
  mobileData: "askFirst",
  audioLanguage: null,
  subtitleLanguage: null,
  subtitlesSdh: false,
  audioDescription: false,
  autoplayNext: true,
};

const orElse = <S extends Schema.Top>(schema: S, fallback: S["Type"]) =>
  Schema.optionalKey(schema.pipe(Schema.catchDecoding(() => Effect.succeedSome(fallback))));

const StoredPreferences = Schema.fromJsonString(
  Schema.Struct({
    quality: orElse(StreamingQuality, DEFAULT_PREFERENCES.quality),
    mobileData: orElse(MobileData, DEFAULT_PREFERENCES.mobileData),
    audioLanguage: orElse(Schema.NullOr(LanguageCode), DEFAULT_PREFERENCES.audioLanguage),
    subtitleLanguage: orElse(Schema.NullOr(LanguageCode), DEFAULT_PREFERENCES.subtitleLanguage),
    subtitlesSdh: orElse(Schema.Boolean, DEFAULT_PREFERENCES.subtitlesSdh),
    audioDescription: orElse(Schema.Boolean, DEFAULT_PREFERENCES.audioDescription),
    autoplayNext: orElse(Schema.Boolean, DEFAULT_PREFERENCES.autoplayNext),
  }),
);

const decodeStored = Schema.decodeUnknownOption(StoredPreferences);

/**
 * The preferences stored as `stored`, from `serializePreferences`. Anything unreadable, including
 * nothing stored yet, reads as the defaults field by field.
 */
export const parsePreferences = (stored: string | null): PlaybackPreferences => ({
  ...DEFAULT_PREFERENCES,
  ...Option.getOrElse(decodeStored(stored), () => ({})),
});

/** The stored form of `preferences`, which `parsePreferences` reads back unchanged. */
export const serializePreferences = (preferences: PlaybackPreferences): string =>
  JSON.stringify(preferences);

/** The preferences the person's settings on the server hold, which follow them to every device. */
export type SyncedPreferences = Pick<
  PlaybackPreferences,
  "quality" | "audioLanguage" | "subtitleLanguage" | "autoplayNext"
>;

const dropInvalid = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));

const StoredSynced = Schema.fromJsonString(
  Schema.Struct({
    quality: dropInvalid(StreamingQuality),
    audioLanguage: dropInvalid(Schema.NullOr(LanguageCode)),
    subtitleLanguage: dropInvalid(Schema.NullOr(LanguageCode)),
    autoplayNext: dropInvalid(Schema.Boolean),
  }),
);

const decodeSynced = Schema.decodeUnknownOption(StoredSynced);

/**
 * The synced preferences stored as `stored`, from `serializeSynced`: only those known, so an
 * unreadable field, or nothing stored, leaves the phone's own value in its place.
 */
export const parseSynced = (stored: string | null): Partial<SyncedPreferences> =>
  Option.getOrElse(decodeSynced(stored), () => ({}));

/** The stored form of `synced`, which `parseSynced` reads back unchanged. */
export const serializeSynced = (synced: Partial<SyncedPreferences>): string =>
  JSON.stringify(synced);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The synced preferences `change` names, leaving out the ones only this phone keeps. */
export const pickSynced = (change: Partial<PlaybackPreferences>): Partial<SyncedPreferences> => {
  const synced: Partial<Mutable<SyncedPreferences>> = {};

  if (change.quality !== undefined) synced.quality = change.quality;

  if (change.audioLanguage !== undefined) synced.audioLanguage = change.audioLanguage;

  if (change.subtitleLanguage !== undefined) synced.subtitleLanguage = change.subtitleLanguage;

  if (change.autoplayNext !== undefined) synced.autoplayNext = change.autoplayNext;

  return synced;
};

/** The person's settings, as `core.settings.get` answers. */
export type CoreSettings = Awaited<ReturnType<PlatformSdk["core"]["settings"]["get"]>>;

/** Some settings to change, as `core.settings.set` takes them. */
export type SettingsChange = Parameters<PlatformSdk["core"]["settings"]["set"]>[0];

/** The core's `streamQuality` setting, which the person keeps per device. */
export type StreamQuality = NonNullable<CoreSettings["device"]>["streamQuality"];

const STREAM_QUALITIES: Readonly<Record<StreamingQuality, StreamQuality>> = {
  auto: "auto",
  "1080p": "high",
  "720p": "standard",
  "480p": "low",
};

const STREAMING_QUALITIES: Readonly<Record<StreamQuality, StreamingQuality>> = {
  auto: "auto",
  original: "auto",
  high: "1080p",
  standard: "720p",
  low: "480p",
};

/** `quality` as the `streamQuality` setting holds it: high, standard, and low are 1080p, 720p, and 480p, as on the web. */
export const streamQualityOf = (quality: StreamingQuality): StreamQuality =>
  STREAM_QUALITIES[quality];

/**
 * The streaming quality the `streamQuality` setting names. This app has no Original choice, and
 * plays `original`, set on the web, uncapped as Auto does.
 */
export const qualityOfStream = (setting: StreamQuality): StreamingQuality =>
  STREAMING_QUALITIES[setting];

/** The synced preferences `settings` hold; the quality only for a session on a device. */
export const syncedOf = (settings: CoreSettings): Partial<SyncedPreferences> => {
  const synced: Partial<Mutable<SyncedPreferences>> = {
    audioLanguage: settings.user.audioLanguage,
    subtitleLanguage: settings.user.subtitleLanguage,
    autoplayNext: settings.user.autoplay,
  };

  if (settings.device !== null) synced.quality = qualityOfStream(settings.device.streamQuality);

  return synced;
};

/**
 * `synced` as a change to the person's settings, or null when it changes none. The quality goes
 * to the server only `onDevice`, since a session on no device keeps no device settings.
 */
export const settingsChangeOf = (
  synced: Partial<SyncedPreferences>,
  onDevice: boolean,
): SettingsChange | null => {
  const change: Mutable<SettingsChange> = {};

  if (synced.audioLanguage !== undefined) change.audioLanguage = synced.audioLanguage;

  if (synced.subtitleLanguage !== undefined) change.subtitleLanguage = synced.subtitleLanguage;

  if (synced.autoplayNext !== undefined) change.autoplay = synced.autoplayNext;

  if (synced.quality !== undefined && onDevice) {
    change.streamQuality = streamQualityOf(synced.quality);
  }

  return Object.keys(change).length === 0 ? null : change;
};

/** A row of a preference picker: the value, its label, and an optional muted detail. */
export interface PreferenceOption<A> {
  readonly value: A;
  readonly label: string;
  readonly detail?: string;
}

/** H26: the player's quality menu (F03), with the rate the media service encodes at each height. */
export const QUALITY_OPTIONS: ReadonlyArray<PreferenceOption<StreamingQuality>> =
  PLAYER_QUALITY_OPTIONS.map((option) =>
    option.rate === null
      ? { value: option.id, label: option.label }
      : { value: option.id, label: option.label, detail: option.rate },
  );

/** H27: the mobile data choices. */
export const MOBILE_DATA_OPTIONS: ReadonlyArray<PreferenceOption<MobileData>> = [
  { value: "askFirst", label: "Ask First" },
  { value: "allowStreaming", label: "Allow Streaming" },
  { value: "wifiOnly", label: "Wi-Fi Only" },
];

/** The preferred audio choices: the file's own default, then each language. */
export const AUDIO_OPTIONS: ReadonlyArray<PreferenceOption<string | null>> = [
  { value: null, label: "Original" },
  ...LANGUAGES.map((language) => ({ value: language.code, label: language.name })),
];

/** The subtitle choices: off, then each language. */
export const SUBTITLE_OPTIONS: ReadonlyArray<PreferenceOption<string | null>> = [
  { value: null, label: "Off" },
  ...LANGUAGES.map((language) => ({ value: language.code, label: language.name })),
];

/** The label of `value` among `options`, such as `Ask First`. */
export const optionLabel = <A>(options: ReadonlyArray<PreferenceOption<A>>, value: A): string =>
  options.find((option) => option.value === value)?.label ?? String(value);

/** The preferred audio as App Settings shows it: `Original` or the language, such as `English`. */
export const audioLabel = (preferences: PlaybackPreferences): string =>
  preferences.audioLanguage === null
    ? "Original"
    : (languageName(preferences.audioLanguage) ?? preferences.audioLanguage);

/** The subtitles as App Settings shows them: `Off`, `English`, or `English · SDH`. */
export const subtitlesLabel = (preferences: PlaybackPreferences): string => {
  if (preferences.subtitleLanguage === null) return "Off";

  const name = languageName(preferences.subtitleLanguage) ?? preferences.subtitleLanguage;

  return preferences.subtitlesSdh ? `${name} · SDH` : name;
};

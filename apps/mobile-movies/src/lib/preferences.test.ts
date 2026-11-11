import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { LANGUAGES, isLanguage, languageName } from "./languages";
import {
  AUDIO_OPTIONS,
  DEFAULT_PREFERENCES,
  MOBILE_DATA_OPTIONS,
  QUALITY_OPTIONS,
  audioLabel,
  optionLabel,
  parsePreferences,
  parseSynced,
  pickSynced,
  qualityOfStream,
  serializePreferences,
  serializeSynced,
  settingsChangeOf,
  streamQualityOf,
  subtitlesLabel,
  syncedOf,
} from "./preferences";
import type { CoreSettings, PlaybackPreferences } from "./preferences";

const language = fc.constantFrom(...LANGUAGES.map((each) => each.code));

const preferences: fc.Arbitrary<PlaybackPreferences> = fc.record({
  quality: fc.constantFrom(...QUALITY_OPTIONS.map((option) => option.value)),
  mobileData: fc.constantFrom(...MOBILE_DATA_OPTIONS.map((option) => option.value)),
  audioLanguage: fc.option(language, { nil: null }),
  subtitleLanguage: fc.option(language, { nil: null }),
  subtitlesSdh: fc.boolean(),
  audioDescription: fc.boolean(),
  autoplayNext: fc.boolean(),
});

const somePreferences: fc.Arbitrary<Partial<PlaybackPreferences>> = fc.record(
  {
    quality: fc.constantFrom(...QUALITY_OPTIONS.map((option) => option.value)),
    mobileData: fc.constantFrom(...MOBILE_DATA_OPTIONS.map((option) => option.value)),
    audioLanguage: fc.option(language, { nil: null }),
    subtitleLanguage: fc.option(language, { nil: null }),
    subtitlesSdh: fc.boolean(),
    audioDescription: fc.boolean(),
    autoplayNext: fc.boolean(),
  },
  { requiredKeys: [] },
);

describe("preferences", () => {
  it("reads back what it stored", () => {
    fc.assert(
      fc.property(preferences, (stored) => {
        expect(parsePreferences(serializePreferences(stored))).toEqual(stored);
      }),
    );
  });

  it("reads nothing, or anything unreadable, as the defaults", () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("not json")).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("[1,2]")).toEqual(DEFAULT_PREFERENCES);
    fc.assert(
      fc.property(fc.string(), (stored) => {
        const parsed = parsePreferences(stored);

        expect(Object.keys(parsed).toSorted()).toEqual(Object.keys(DEFAULT_PREFERENCES).toSorted());
      }),
    );
  });

  it("keeps each valid field when another is not", () => {
    expect(
      parsePreferences(
        JSON.stringify({ quality: "720p", mobileData: "sometimes", audioLanguage: "English" }),
      ),
    ).toEqual({ ...DEFAULT_PREFERENCES, quality: "720p" });
  });

  it("labels the choices as App Settings shows them", () => {
    expect(optionLabel(MOBILE_DATA_OPTIONS, "wifiOnly")).toBe("Wi-Fi Only");
    expect(optionLabel(AUDIO_OPTIONS, null)).toBe("Original");
    expect(audioLabel(DEFAULT_PREFERENCES)).toBe("Original");
    expect(audioLabel({ ...DEFAULT_PREFERENCES, audioLanguage: "es" })).toBe("Español");
    expect(subtitlesLabel(DEFAULT_PREFERENCES)).toBe("Off");
    expect(
      subtitlesLabel({ ...DEFAULT_PREFERENCES, subtitleLanguage: "en", subtitlesSdh: true }),
    ).toBe("English · SDH");
    expect(subtitlesLabel({ ...DEFAULT_PREFERENCES, subtitleLanguage: "ja" })).toBe("日本語");
  });
});

const settings = (device: CoreSettings["device"]): CoreSettings => ({
  user: {
    subtitleLanguage: "fr",
    audioLanguage: null,
    subtitleStyle: { size: "medium", color: "white", backdrop: "shadow" },
    autoplay: false,
    explicitFilter: false,
    crossfade: 0,
    gapless: true,
  },
  device,
});

describe("synced preferences", () => {
  it("keeps the quality the person's settings hold for each choice, as the web does", () => {
    expect(QUALITY_OPTIONS.map((option) => streamQualityOf(option.value))).toEqual([
      "auto",
      "high",
      "standard",
      "low",
    ]);

    for (const option of QUALITY_OPTIONS) {
      expect(qualityOfStream(streamQualityOf(option.value))).toBe(option.value);
    }

    expect(qualityOfStream("original")).toBe("auto");
  });

  it("reads the languages, autoplay, and this device's quality from the settings", () => {
    expect(
      syncedOf(settings({ streamQuality: "standard", downloadQuality: "high", volume: 1 })),
    ).toEqual({
      subtitleLanguage: "fr",
      audioLanguage: null,
      autoplayNext: false,
      quality: "720p",
    });
    expect(syncedOf(settings(null))).toEqual({
      subtitleLanguage: "fr",
      audioLanguage: null,
      autoplayNext: false,
    });
  });

  it("sends only the synced preferences a change names", () => {
    expect(pickSynced({ mobileData: "wifiOnly", subtitlesSdh: true })).toEqual({});
    expect(settingsChangeOf(pickSynced({ mobileData: "wifiOnly" }), true)).toBeNull();
    expect(
      settingsChangeOf(
        pickSynced({ subtitleLanguage: "en", audioDescription: true, autoplayNext: true }),
        true,
      ),
    ).toEqual({ subtitleLanguage: "en", autoplay: true });
    expect(settingsChangeOf({ audioLanguage: null }, true)).toEqual({ audioLanguage: null });
    expect(settingsChangeOf({ quality: "480p" }, true)).toEqual({ streamQuality: "low" });
    expect(settingsChangeOf({ quality: "480p" }, false)).toBeNull();
  });

  it("reads back what it stored, and drops what it cannot read", () => {
    fc.assert(
      fc.property(somePreferences, (stored) => {
        const synced = pickSynced(stored);

        expect(parseSynced(serializeSynced(synced))).toEqual(synced);
      }),
    );
    expect(parseSynced(null)).toEqual({});
    expect(parseSynced("not json")).toEqual({});
    expect(
      parseSynced(JSON.stringify({ quality: "4k", subtitleLanguage: "en", autoplayNext: "yes" })),
    ).toEqual({ subtitleLanguage: "en" });
  });
});

describe("languages", () => {
  it("matches track tags in either ISO code and with a region", () => {
    expect(isLanguage("eng", "en")).toBe(true);
    expect(isLanguage("en-US", "en")).toBe(true);
    expect(isLanguage("fre", "fr")).toBe(true);
    expect(isLanguage("fra", "fr")).toBe(true);
    expect(isLanguage("nb", "no")).toBe(true);
    expect(isLanguage("iw", "he")).toBe(true);
    expect(isLanguage("in-ID", "id")).toBe(true);
    expect(isLanguage("spa", "en")).toBe(false);
    expect(isLanguage("und", "en")).toBe(false);
    expect(isLanguage(null, "en")).toBe(false);
  });

  it("matches every listed code to itself and names it", () => {
    for (const each of LANGUAGES) {
      expect(isLanguage(each.code, each.code)).toBe(true);

      for (const other of each.others) expect(isLanguage(other, each.code)).toBe(true);
      expect(languageName(each.code)).toBe(each.name);
    }

    expect(languageName("xx")).toBe("XX");
  });
});

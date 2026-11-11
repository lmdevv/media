/**
 * Languages of audio and subtitle tracks and of the preferred-language pickers (F02, H28), named in
 * their own language as the Apple TV app does: `English`, `Español`, `日本語`. Hermes has no
 * `Intl.DisplayNames`, so common languages are listed here by their ISO 639-1 code with the ISO
 * 639-2 codes (bibliographic and terminology) media files tag tracks with, plus the Norwegian
 * `nb`/`nn` and the legacy `iw` and `in` some tools still write.
 */

interface Language {
  readonly code: string;
  readonly name: string;
  readonly others: ReadonlyArray<string>;
}

/** Languages in picker order: the most common track languages first. */
export const LANGUAGES: ReadonlyArray<Language> = [
  { code: "en", name: "English", others: ["eng"] },
  { code: "es", name: "Español", others: ["spa"] },
  { code: "fr", name: "Français", others: ["fre", "fra"] },
  { code: "de", name: "Deutsch", others: ["ger", "deu"] },
  { code: "it", name: "Italiano", others: ["ita"] },
  { code: "pt", name: "Português", others: ["por"] },
  { code: "nl", name: "Nederlands", others: ["dut", "nld"] },
  { code: "sv", name: "Svenska", others: ["swe"] },
  { code: "no", name: "Norsk", others: ["nor", "nob", "nno", "nb", "nn"] },
  { code: "da", name: "Dansk", others: ["dan"] },
  { code: "fi", name: "Suomi", others: ["fin"] },
  { code: "pl", name: "Polski", others: ["pol"] },
  { code: "cs", name: "Čeština", others: ["cze", "ces"] },
  { code: "hu", name: "Magyar", others: ["hun"] },
  { code: "ro", name: "Română", others: ["rum", "ron"] },
  { code: "el", name: "Ελληνικά", others: ["gre", "ell"] },
  { code: "tr", name: "Türkçe", others: ["tur"] },
  { code: "ru", name: "Русский", others: ["rus"] },
  { code: "uk", name: "Українська", others: ["ukr"] },
  { code: "ar", name: "العربية", others: ["ara"] },
  { code: "he", name: "עברית", others: ["heb", "iw"] },
  { code: "hi", name: "हिन्दी", others: ["hin"] },
  { code: "th", name: "ไทย", others: ["tha"] },
  { code: "vi", name: "Tiếng Việt", others: ["vie"] },
  { code: "id", name: "Bahasa Indonesia", others: ["ind", "in"] },
  { code: "ja", name: "日本語", others: ["jpn"] },
  { code: "ko", name: "한국어", others: ["kor"] },
  { code: "zh", name: "中文", others: ["chi", "zho"] },
];

const baseCode = (tag: string | null | undefined): string | null => {
  if (tag === null || tag === undefined) return null;

  const base = tag.toLowerCase().split(/[-_]/u)[0] ?? "";

  if (base === "" || base === "und") return null;

  return (
    LANGUAGES.find((language) => language.code === base || language.others.includes(base))?.code ??
    base
  );
};

/**
 * The language's own name for a tag in either ISO code, such as `Español` for `es`, `spa`, or
 * `es-MX`; the tag upper-cased for languages not listed; null when undetermined (`und`).
 */
export const languageName = (tag: string | null | undefined): string | null => {
  const code = baseCode(tag);

  if (code === null || tag === null || tag === undefined) return null;

  return LANGUAGES.find((language) => language.code === code)?.name ?? tag.toUpperCase();
};

/**
 * Whether a track tagged `tag` (`eng`, `en`, `en-US`) is in the language `code` (`en`), so the
 * player can pick the preferred audio and subtitle tracks.
 */
export const isLanguage = (tag: string | null | undefined, code: string): boolean =>
  baseCode(tag) === code;

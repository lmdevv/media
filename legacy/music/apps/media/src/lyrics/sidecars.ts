/**
 * Lyric files beside a song: the song's file name with a lyrics extension (`Song.lrc` for
 * `Song.flac`), or with a language before it (`Song.de.lrc`), and Lyricsfile's compound
 * `Song.lyricsfile.yaml`.
 */
import { basename, dirname } from "node:path";

import {
  type Lang,
  LyricOrigin,
  type LyricSet,
  type LyricsFormat,
  parseLang,
} from "@music/commands/lyrics";

import { extensionOf, isAudioFile } from "../audio-format.ts";
import type { WalkedFile } from "../platform/node-files.ts";
import type { ParsedLyricSet } from "./lyric-body.ts";

const FORMATS: ReadonlyMap<string, LyricsFormat> = new Map([
  ["lrc", "lrc"],
  ["elrc", "elrc"],
  ["ttml", "ttml"],
  ["vtt", "vtt"],
  ["srt", "srt"],
  ["txt", "txt"],
  ["yaml", "lyricsfile"],
  ["yml", "lyricsfile"],
]);

const LYRICSFILE_INFIX = /\.lyricsfile$/iu;

/**
 * ISO 639-1 language codes. A language in a file name must start with one: three-letter names
 * such as `alt`, `bak`, `new`, and `old` are file name words far more often than ISO 639-2 codes.
 */
const ISO_639_1 = new Set(
  (
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv " +
    "cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr " +
    "ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw " +
    "ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv " +
    "ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr " +
    "ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi " +
    "yo za zh zu"
  ).split(" "),
);

/** A language with an optional script and region, as canonical BCP 47 spells them. */
const NAME_LANG = /^[a-z]{2}(?:-([A-Z][a-z]{3}))?(?:-([A-Z]{2}|\d{3}))?$/u;

const SCRIPTS = new Intl.DisplayNames(["en"], { type: "script", fallback: "none" });

const REGIONS = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

/**
 * The language a lyric file's name carries after the song's name (`de`, `zh-Hant`, `pt-BR`), or
 * null. Only a known script and region may follow the language, so `en-live`, `en-notes`, and
 * `no-lyrics` name versions of the lyrics, not languages.
 */
const nameLang = (suffix: string): Lang | null => {
  const [primary = ""] = suffix.split(/[-_]/u);

  if (!ISO_639_1.has(primary.toLowerCase())) return null;
  const lang = parseLang(suffix);
  const subtags = lang === null ? null : NAME_LANG.exec(lang);

  if (subtags === null) return null;
  const [, script, region] = subtags;

  return (script === undefined || SCRIPTS.of(script) !== undefined) &&
    (region === undefined || REGIONS.of(region) !== undefined)
    ? lang
    : null;
};

/** True when a file name has a lyric file extension. */
export const isLyricsSidecar = (name: string): boolean => FORMATS.has(extensionOf(name));

/** One lyric file found for a song. */
export interface LyricsSidecar {
  readonly file: WalkedFile;
  readonly format: LyricsFormat;
  /** The language its name carries (`Song.de.lrc`), or null for the song's own name. */
  readonly lang: Lang | null;
}

const withoutExtension = (name: string): string => name.slice(0, name.lastIndexOf("."));

/** A lyric file's name without its extension, and without `.lyricsfile` before `.yaml`. */
const stemOf = (name: string, format: LyricsFormat): string => {
  const stem = withoutExtension(name);

  return format === "lyricsfile" ? stem.replace(LYRICSFILE_INFIX, "") : stem;
};

/**
 * Matches songs to their lyric files from the files a library walk found (paths relative to the
 * library, `/`-separated). A name that is exactly another song's name belongs to that song, so
 * `Song.en.lrc` is the lyrics of `Song.en.mp3` when that file exists, not English lyrics of
 * `Song.mp3`.
 *
 * @returns A lookup from a song's relative path to its lyric files, its own name first.
 */
export const lyricsSidecarMatcher = (
  walked: ReadonlyArray<WalkedFile>,
): ((audioPath: string) => ReadonlyArray<LyricsSidecar>) => {
  const songs = new Set<string>();

  /**
   * Lyric files under `folder/prefix` for every dot-separated prefix of their stem, so a song
   * reads only the files named after it: `Song.de.lrc` is under `Song` and `Song.de`.
   */
  const sidecars = new Map<
    string,
    Array<{ readonly file: WalkedFile; readonly format: LyricsFormat; readonly stem: string }>
  >();

  for (const file of walked) {
    const name = basename(file.relativePath);
    const folder = dirname(file.relativePath);
    const format = FORMATS.get(extensionOf(name));

    if (isAudioFile(name)) songs.add(`${folder}/${withoutExtension(name)}`);

    if (format === undefined) continue;
    const stem = stemOf(name, format);

    for (let end = stem.indexOf("."); ; end = stem.indexOf(".", end + 1)) {
      const key = `${folder}/${end === -1 ? stem : stem.slice(0, end)}`;
      const named = sidecars.get(key) ?? [];

      named.push({ file, format, stem });
      sidecars.set(key, named);

      if (end === -1) break;
    }
  }

  return (audioPath) => {
    const folder = dirname(audioPath);
    const song = withoutExtension(basename(audioPath));

    return (sidecars.get(`${folder}/${song}`) ?? [])
      .flatMap(({ file, format, stem }): ReadonlyArray<LyricsSidecar> => {
        if (stem === song) return [{ file, format, lang: null }];

        if (songs.has(`${folder}/${stem}`)) return [];
        const lang = nameLang(stem.slice(song.length + 1));

        return lang === null ? [] : [{ file, format, lang }];
      })
      .toSorted(
        (a, b) =>
          Number(a.lang !== null) - Number(b.lang !== null) ||
          a.file.relativePath.localeCompare(b.file.relativePath),
      );
  };
};

/**
 * Identifies one version of a song's lyric files, `name:size:mtime` for each joined by `/`
 * (which no file name holds). An empty string means the song has none. A song whose stored key
 * differs from the current one has its lyrics read again.
 */
export const lyricsFilesKey = (sidecars: ReadonlyArray<LyricsSidecar>): string =>
  sidecars
    .map(({ file }) => `${basename(file.relativePath)}:${file.size}:${Math.trunc(file.mtimeMs)}`)
    .toSorted()
    .join("/");

/** One lyric file and the sets read from it. */
export interface ReadSidecar {
  readonly sidecar: LyricsSidecar;
  readonly sets: ReadonlyArray<ParsedLyricSet>;
}

const primaryOf = (lang: Lang): string => lang.split("-")[0] ?? lang;

/**
 * A song's own lyric sets from its lyric files and tags, files first. A file named with a
 * language is a translation when the song has main lyrics, from a file under its own name or
 * from a tag, in another known language. Beside main lyrics in the same language, or in none,
 * it is main lyrics too, and the reader picks between them.
 */
export const localLyricSets = (
  read: ReadonlyArray<ReadSidecar>,
  embedded: ReadonlyArray<LyricSet>,
): ReadonlyArray<LyricSet> => {
  const mainLanguages = new Set(
    [
      ...embedded,
      ...read.flatMap(({ sidecar, sets }) => (sidecar.lang === null ? sets : [])),
    ].flatMap((set) => (set.kind === "main" && set.lang !== null ? [primaryOf(set.lang)] : [])),
  );

  const translates = (lang: Lang): boolean =>
    [...mainLanguages].some((main) => main !== primaryOf(lang));

  const fromFiles = read.flatMap(({ sidecar, sets }) => {
    const origin = LyricOrigin.cases.Sidecar.make({
      fileName: basename(sidecar.file.relativePath),
      format: sidecar.format,
    });

    return sets.map((set): LyricSet => ({
      kind:
        set.kind === "main" && sidecar.lang !== null && translates(sidecar.lang)
          ? "translation"
          : set.kind,
      lang: set.kind === "main" ? (sidecar.lang ?? set.lang) : set.lang,
      origin,
      body: set.body,
    }));
  });

  return [...fromFiles, ...embedded];
};

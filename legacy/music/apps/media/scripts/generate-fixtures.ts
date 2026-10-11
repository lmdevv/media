/**
 * Generates a small synthetic music library with ffmpeg, for tests and local development.
 *
 *   node scripts/generate-fixtures.ts <target-dir>
 *
 * Two artists and four albums mix FLAC 16/44.1, FLAC 24/96, MP3 320, and AAC in M4A, with full
 * tags, short chords, and embedded cover art, except one album that ships a `cover.jpg` file.
 * A hidden folder and a text file check that scans skip what is not music.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

type Format = "flac16" | "flac24" | "mp3" | "m4a";

/** One generated track, as the scanner should read it. */
export interface FixtureTrack {
  /** Path relative to the library root, with `/` separators. */
  readonly path: string;
  readonly title: string;
  readonly trackNumber: number;
}

/** One generated album. */
export interface FixtureAlbum {
  readonly artist: string;
  readonly title: string;
  readonly year: number;
  readonly genre: string;
  readonly format: Format;
  /** `embedded` art lives in the files; `folder` art is a `cover.jpg` beside them. */
  readonly art: "embedded" | "folder";
  readonly tracks: ReadonlyArray<FixtureTrack>;
}

interface AlbumPlan {
  readonly artist: string;
  readonly title: string;
  readonly year: number;
  readonly genre: string;
  readonly format: Format;
  readonly art: "embedded" | "folder";
  readonly color: string;
  readonly titles: ReadonlyArray<string>;
}

const PLANS: ReadonlyArray<AlbumPlan> = [
  {
    artist: "Aurora Tones",
    title: "First Light",
    year: 2021,
    genre: "Ambient",
    format: "flac16",
    art: "embedded",
    color: "0xe4572e",
    titles: ["Dawn", "Morning Haze", "Golden Hour"],
  },
  {
    artist: "Aurora Tones",
    title: "Night Drive",
    year: 2023,
    genre: "Synthwave",
    format: "mp3",
    art: "embedded",
    color: "0x2e86ab",
    titles: ["Neon", "Overpass", "Last Exit"],
  },
  {
    artist: "The Sine Waves",
    title: "Harmonics",
    year: 2019,
    genre: "Electronic",
    format: "flac24",
    art: "embedded",
    color: "0x76b041",
    titles: ["Fundamental", "Overtone"],
  },
  {
    artist: "The Sine Waves",
    title: "Folder Art",
    year: 2020,
    genre: "Jazz",
    format: "m4a",
    art: "folder",
    color: "0x9b5de5",
    titles: ["Brushes", "Walking Bass"],
  },
];

/** Root frequencies of the chords each track plays, in hertz. */
const ROOTS = [261.63, 293.66, 329.63, 349.23, 392];

const EXTENSIONS: Record<Format, string> = {
  flac16: "flac",
  flac24: "flac",
  mp3: "mp3",
  m4a: "m4a",
};

const SECONDS = 4;

const ffmpeg = async (args: ReadonlyArray<string>): Promise<void> => {
  await run(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    ...args,
  ]);
};

/** A major chord on `root` with a soft attack and release. */
const chord = (root: number, sampleRate: number): string => {
  const envelope = `min(1,t*4)*min(1,(${SECONDS}-t)*2)`;
  const tones = [1, 1.25, 1.5].map((ratio) => `sin(2*PI*${(root * ratio).toFixed(2)}*t)`).join("+");

  return `aevalsrc=exprs='0.2*${envelope}*(${tones})':s=${sampleRate}:d=${SECONDS}`;
};

/** Draws a square cover in `color` with the album title, or a plain square without fonts. */
const drawCover = async (path: string, color: string, title: string): Promise<void> => {
  const source = `color=c=${color}:s=600x600:d=1`;
  const text = title.replaceAll(/[':\\]/g, "");

  try {
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      source,
      "-vf",
      `drawtext=text='${text}':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=(h-text_h)/2`,
      "-frames:v",
      "1",
      path,
    ]);
  } catch {
    await ffmpeg(["-f", "lavfi", "-i", source, "-frames:v", "1", path]);
  }
};

const CODEC_ARGS: Record<Format, ReadonlyArray<string>> = {
  flac16: ["-c:a", "flac", "-sample_fmt", "s16"],
  flac24: ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"],
  mp3: ["-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3"],
  m4a: ["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"],
};

const coverArgs = (format: Format, cover: string): ReadonlyArray<string> => [
  "-i",
  cover,
  "-map",
  "0:a",
  "-map",
  "1:v",
  "-c:v",
  format === "mp3" ? "mjpeg" : "png",
  "-disposition:v",
  "attached_pic",
  "-metadata:s:v",
  "comment=Cover (front)",
];

const generateAlbum = async (root: string, plan: AlbumPlan): Promise<FixtureAlbum> => {
  const folder = join(plan.artist, plan.title);
  const directory = join(root, folder);
  const sampleRate = plan.format === "flac24" ? 96_000 : 44_100;
  await mkdir(directory, { recursive: true });

  const cover = join(
    directory,
    plan.art === "folder" ? "cover.jpg" : `.cover-${plan.format === "mp3" ? "art.jpg" : "art.png"}`,
  );

  await drawCover(cover, plan.color, plan.title);

  const tracks = await Promise.all(
    plan.titles.map(async (title, index) => {
      const trackNumber = index + 1;
      const fileName = `${String(trackNumber).padStart(2, "0")} ${title}.${EXTENSIONS[plan.format]}`;

      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        chord(ROOTS[index % ROOTS.length] ?? 261.63, sampleRate),
        ...(plan.art === "embedded" ? coverArgs(plan.format, cover) : []),
        ...CODEC_ARGS[plan.format],
        "-metadata",
        `title=${title}`,
        "-metadata",
        `artist=${plan.artist}`,
        "-metadata",
        `album_artist=${plan.artist}`,
        "-metadata",
        `album=${plan.title}`,
        "-metadata",
        `track=${trackNumber}/${plan.titles.length}`,
        "-metadata",
        "disc=1/1",
        "-metadata",
        `date=${plan.year}`,
        "-metadata",
        `genre=${plan.genre}`,
        join(directory, fileName),
      ]);

      return { path: `${plan.artist}/${plan.title}/${fileName}`, title, trackNumber };
    }),
  );

  if (plan.art === "embedded") await rm(cover);
  const { color: _color, titles: _titles, ...album } = plan;

  return { ...album, tracks };
};

/**
 * Writes the fixture library into `target`, replacing anything already there, and returns what
 * it wrote. `albumSuffix` is appended to every album title so a run can find its own albums in a
 * shared deployment. Requires ffmpeg on `PATH` or at `FFMPEG_PATH`.
 */
export const generateFixtureLibrary = async (
  target: string,
  albumSuffix = "",
): Promise<ReadonlyArray<FixtureAlbum>> => {
  const root = resolve(target);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const albums = await Promise.all(
    PLANS.map((plan) => generateAlbum(root, { ...plan, title: `${plan.title}${albumSuffix}` })),
  );

  await mkdir(join(root, ".hidden"), { recursive: true });
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    chord(440, 44_100),
    "-c:a",
    "libmp3lame",
    join(root, ".hidden", "ignored.mp3"),
  ]);
  await writeFile(join(root, "notes.txt"), "Not music.\n");

  return albums;
};

if (import.meta.main) {
  const [target] = process.argv.slice(2);

  if (target === undefined) {
    console.error("Usage: node scripts/generate-fixtures.ts <target-dir>");
    process.exitCode = 2;
  } else {
    const albums = await generateFixtureLibrary(target);
    const tracks = albums.reduce((sum, album) => sum + album.tracks.length, 0);
    console.log(`Wrote ${albums.length} albums, ${tracks} tracks to ${resolve(target)}`);
  }
}

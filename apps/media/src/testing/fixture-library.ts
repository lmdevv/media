import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { qsvProbeArgs, vaapiProbeArgs } from "../playback/hardware-acceleration.ts";

const run = promisify(execFile);

const ffmpegPath = process.env["FFMPEG_PATH"] ?? "ffmpeg";

/** Paths of the generated files, relative to the library roots. */
export interface FixtureLibrary {
  readonly moviesRoot: string;
  readonly showsRoot: string;
  /**
   * H.264/AAC in MP4: direct play everywhere. 12 seconds, a keyframe every 2 seconds, and two
   * chapters ("Opening" to 0:05, then "Credits").
   */
  readonly directMovie: string;
  /**
   * H.264 with B-frames, AC-3 and E-AC-3 tracks in MKV, an embedded SRT, and sidecar SRT and ASS
   * subtitles. 12 seconds, a keyframe every 2 seconds. The B-frames make ffmpeg's stream-copy seek
   * start one keyframe early.
   */
  readonly remuxMovie: string;
  /** HEVC Main 10 tagged as HDR10 (BT.2020, PQ) in MKV. */
  readonly hdrMovie: string;
  /** A loose file with a scene-release name in the movies root. */
  readonly messyMovie: string;
  readonly episodes: ReadonlyArray<string>;
}

const encode = async (args: ReadonlyArray<string>, output: string): Promise<void> => {
  await mkdir(dirname(output), { recursive: true });
  await run(ffmpegPath, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args, output]);
};

const testVideo = (seconds: number, size: string): ReadonlyArray<string> => [
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=${size}:rate=24:duration=${seconds}`,
];

const testAudio = (seconds: number, frequency: number): ReadonlyArray<string> => [
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`,
];

const h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "48"];

const image = (color: string, size: string, output: string): Promise<void> =>
  encode(["-f", "lavfi", "-i", `color=c=${color}:s=${size}`, "-frames:v", "1"], output);

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello from the fixture.

2
00:00:04,000 --> 00:00:06,500
<i>Second</i> line & more.
`;

const ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\b1}Bonjour{\\b0} le monde
`;

const CHAPTERS = `;FFMETADATA1
[CHAPTER]
TIMEBASE=1/1000
START=0
END=5000
title=Opening
[CHAPTER]
TIMEBASE=1/1000
START=5000
END=12000
title=Credits
`;

const MOVIE_NFO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Big Buck Fixture</title>
  <originaltitle>Big Buck Fixture</originaltitle>
  <year>2008</year>
  <plot>A rabbit &amp; a test pattern.</plot>
  <mpaa>PG</mpaa>
  <ratings>
    <rating name="imdb" max="10" default="true"><value>7.5</value><votes>100</votes></rating>
  </ratings>
  <genre>Animation</genre>
  <genre>Comedy</genre>
  <uniqueid type="tmdb" default="true">10378</uniqueid>
  <uniqueid type="imdb">tt1254207</uniqueid>
</movie>
`;

const SHOW_NFO = `<?xml version="1.0" encoding="UTF-8"?>
<tvshow>
  <title>Fixture Show</title>
  <year>2021</year>
  <plot><![CDATA[A show made of <colour bars>.]]></plot>
  <genre>Drama</genre>
  <uniqueid type="tvdb">123456</uniqueid>
  <uniqueid type="tmdb" default="true">99999</uniqueid>
</tvshow>
`;

const EPISODE_NFO = `<?xml version="1.0" encoding="UTF-8"?>
<episodedetails>
  <title>Pilot (Local)</title>
  <season>1</season>
  <episode>1</episode>
  <aired>2021-01-01</aired>
  <plot>The first one.</plot>
</episodedetails>
`;

/** Generates the fixture library under `root` and returns where everything went. */
export const generateFixtureLibrary = async (root: string): Promise<FixtureLibrary> => {
  const moviesRoot = join(root, "movies");
  const showsRoot = join(root, "shows");
  const directMovie = "Big Buck Fixture (2008)/Big Buck Fixture (2008).mp4";
  const remuxMovie = "Remux Fixture (2015)/Remux Fixture (2015).mkv";
  const hdrMovie = "HDR Fixture (2020)/HDR Fixture (2020).mkv";
  const messyMovie = "Messy.Release.Name.2012.1080p.BluRay.x264-GROUP.mkv";
  const show = "Fixture Show (2021)";

  const episodes = [
    `${show}/Season 01/Fixture Show - S01E01 - Pilot.mkv`,
    `${show}/Season 01/Fixture Show - S01E02 - Second.mkv`,
    `${show}/Season 01/Fixture Show - S01E03E04 - Double.mkv`,
    `${show}/Season 02/Fixture.Show.S02E01.Return.720p.WEB-DL.mp4`,
    `${show}/Season 02/Fixture Show - 2x02 - Again.mp4`,
    `${show}/Specials/Fixture Show - S00E01 - Special.mkv`,
  ];

  const remuxDir = join(moviesRoot, dirname(remuxMovie));
  const srtPath = join(remuxDir, "Remux Fixture (2015).en.srt");
  const chaptersPath = join(root, "chapters.txt");
  await mkdir(remuxDir, { recursive: true });
  await writeFile(chaptersPath, CHAPTERS);
  await writeFile(srtPath, SRT);
  await writeFile(join(remuxDir, "Remux Fixture (2015).fr.forced.ass"), ASS);

  await Promise.all([
    encode(
      [
        ...testVideo(12, "320x180"),
        ...testAudio(12, 440),
        "-i",
        chaptersPath,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-map_chapters",
        "2",
        ...h264,
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
      ],
      join(moviesRoot, directMovie),
    ),
    encode(
      [
        ...testVideo(12, "320x180"),
        ...testAudio(12, 440),
        ...testAudio(12, 660),
        "-i",
        srtPath,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-map",
        "2:a",
        "-map",
        "3:s",
        ...h264,
        "-bf",
        "2",
        "-c:a:0",
        "ac3",
        "-c:a:1",
        "eac3",
        "-ac:a:1",
        "6",
        "-c:s",
        "srt",
        "-metadata:s:a:0",
        "language=eng",
        "-metadata:s:a:1",
        "language=fre",
        "-metadata:s:s:0",
        "language=eng",
        "-disposition:a:0",
        "default",
        "-disposition:s:0",
        "0",
      ],
      join(moviesRoot, remuxMovie),
    ),
    encode(
      [
        ...testVideo(6, "320x180"),
        ...testAudio(6, 440),
        "-vf",
        "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
        "-c:v",
        "libx265",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p10le",
        "-x265-params",
        "log-level=error:keyint=48:hdr10=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400",
        "-c:a",
        "aac",
      ],
      join(moviesRoot, hdrMovie),
    ),
    encode(
      [...testVideo(2, "160x90"), ...testAudio(2, 330), ...h264, "-c:a", "aac"],
      join(moviesRoot, messyMovie),
    ),
    ...episodes.map((episode, index) =>
      encode(
        [...testVideo(2, "160x90"), ...testAudio(2, 220 + index * 20), ...h264, "-c:a", "aac"],
        join(showsRoot, episode),
      ),
    ),
    image("red", "200x300", join(moviesRoot, "Big Buck Fixture (2008)/poster.jpg")),
    image("blue", "640x360", join(moviesRoot, "Big Buck Fixture (2008)/fanart.jpg")),
    image("green", "200x300", join(moviesRoot, "Remux Fixture (2015)/folder.jpg")),
    image("purple", "200x300", join(showsRoot, show, "poster.png")),
    image("orange", "640x360", join(showsRoot, show, "fanart.jpg")),
    image("yellow", "200x300", join(showsRoot, show, "season01-poster.jpg")),
    image("gray", "200x300", join(showsRoot, show, "Season 02/folder.jpg")),
    image(
      "white",
      "320x180",
      join(showsRoot, show, "Season 01/Fixture Show - S01E01 - Pilot-thumb.jpg"),
    ),
  ]);

  await writeFile(join(moviesRoot, "Big Buck Fixture (2008)/movie.nfo"), MOVIE_NFO);
  await writeFile(join(showsRoot, show, "tvshow.nfo"), SHOW_NFO);
  await writeFile(
    join(showsRoot, show, "Season 01/Fixture Show - S01E01 - Pilot.nfo"),
    EPISODE_NFO,
  );

  return { moviesRoot, showsRoot, directMovie, remuxMovie, hdrMovie, messyMovie, episodes };
};

/** True when an ffmpeg binary can be started. */
export const ffmpegAvailable = async (): Promise<boolean> => {
  try {
    await run(ffmpegPath, ["-version"]);

    return true;
  } catch {
    return false;
  }
};

/** `unshare` flags for a new user and pid namespace, where this user may choose the next pid. */
export const ISOLATED_PIDS = ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc"];

/** Whether this host lets an unprivileged user make that namespace, as Linux usually does. */
export const pidNamespacesAvailable = async (): Promise<boolean> => {
  try {
    await run("unshare", [...ISOLATED_PIDS, "true"]);

    return true;
  } catch {
    return false;
  }
};

/** Whether this ffmpeg can tone-map HDR in software (`zscale` and `tonemap`). */
export const softwareToneMappingAvailable = async (): Promise<boolean> => {
  try {
    const { stdout } = await run(ffmpegPath, ["-hide_banner", "-filters"]);

    return /\szscale\s/u.test(stdout) && /\stonemap\s/u.test(stdout);
  } catch {
    return false;
  }
};

/** True when `FFMPEG_PATH` (or `ffmpeg`) can encode with Intel QSV on `QSV_DEVICE`. */
export const qsvUsable = async (): Promise<boolean> => {
  try {
    await run(ffmpegPath, [...qsvProbeArgs(process.env["QSV_DEVICE"] ?? "/dev/dri/renderD128")]);

    return true;
  } catch {
    return false;
  }
};

/** True when `FFMPEG_PATH` (or `ffmpeg`) can encode with VA-API on `VAAPI_DEVICE`. */
export const vaapiUsable = async (): Promise<boolean> => {
  try {
    await run(ffmpegPath, [
      ...vaapiProbeArgs(process.env["VAAPI_DEVICE"] ?? "/dev/dri/renderD128"),
    ]);

    return true;
  } catch {
    return false;
  }
};

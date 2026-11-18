import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { Browser } from "@playwright/test";

const run = promisify(execFile);

const ffmpegPath = process.env["FFMPEG_PATH"] ?? "ffmpeg";

type Encoding = "uhd-hdr" | "hd";

interface FixtureMovie {
  readonly name: string;
  readonly year: number;
  readonly certification: string;
  readonly minutes: number;
  readonly genres: ReadonlyArray<string>;
  readonly tmdb: string;
  readonly plot: string;
  readonly encoding: Encoding;
}

const MOVIES: ReadonlyArray<FixtureMovie> = [
  {
    name: "Dune Part Two",
    year: 2024,
    certification: "PG-13",
    minutes: 166,
    genres: ["Sci-fi", "Adventure"],
    tmdb: "693134",
    plot: "Paul Atreides joins the Fremen and wages war on the house that destroyed his family.",
    encoding: "uhd-hdr",
  },
  {
    name: "Past Lives",
    year: 2023,
    certification: "PG-13",
    minutes: 106,
    genres: ["Drama", "Romance"],
    tmdb: "666277",
    plot: "Two childhood friends meet again in New York, twenty years after they were parted.",
    encoding: "hd",
  },
  {
    name: "Perfect Days",
    year: 2023,
    certification: "PG",
    minutes: 124,
    genres: ["Drama"],
    tmdb: "976893",
    plot: "A Tokyo toilet cleaner finds quiet joy in music, books, and the trees he photographs.",
    encoding: "hd",
  },
  {
    name: "Arrival",
    year: 2016,
    certification: "PG-13",
    minutes: 116,
    genres: ["Sci-fi", "Drama"],
    tmdb: "329865",
    plot: "A linguist is asked to talk with the visitors whose ships have landed around the world.",
    encoding: "uhd-hdr",
  },
  {
    name: "Spirited Away",
    year: 2001,
    certification: "PG",
    minutes: 125,
    genres: ["Animation", "Fantasy"],
    tmdb: "129",
    plot: "A girl wanders into a world of spirits and works in a bathhouse to free her parents.",
    encoding: "hd",
  },
  {
    name: "Sicario",
    year: 2015,
    certification: "R",
    minutes: 121,
    genres: ["Thriller", "Crime"],
    tmdb: "273481",
    plot: "An FBI agent joins a task force fighting a cartel across the border.",
    encoding: "hd",
  },
  {
    name: "Paddington 2",
    year: 2017,
    certification: "PG",
    minutes: 103,
    genres: ["Comedy", "Family"],
    tmdb: "346648",
    plot: "Paddington takes odd jobs to buy a pop-up book and ends up framed for its theft.",
    encoding: "uhd-hdr",
  },
  {
    name: "Blade Runner 2049",
    year: 2017,
    certification: "R",
    minutes: 164,
    genres: ["Sci-fi", "Thriller"],
    tmdb: "335984",
    plot: "A blade runner digs up a secret that could plunge what is left of society into chaos.",
    encoding: "hd",
  },
  {
    name: "My Neighbor Totoro",
    year: 1988,
    certification: "G",
    minutes: 86,
    genres: ["Animation", "Family"],
    tmdb: "8392",
    plot: "Two sisters move to the country and befriend the forest spirits near their new home.",
    encoding: "hd",
  },
  {
    name: "Aftersun",
    year: 2022,
    certification: "R",
    minutes: 102,
    genres: ["Drama"],
    tmdb: "965150",
    plot: "A woman looks back on a holiday in Turkey with her father, twenty years earlier.",
    encoding: "uhd-hdr",
  },
];

const SHOW = {
  name: "Severance",
  year: 2022,
  certification: "TV-MA",
  minutes: 50,
  genres: ["Sci-fi", "Thriller", "Drama"],
  tmdb: "95396",
  plot: "Office workers whose memories are surgically divided between work and home.",
  seasons: [
    ["Good News About Hell", "Half Loop", "In Perpetuity", "The You You Are"],
    ["Hello, Ms. Cobel", "Goodbye, Mrs. Selvig", "Who Is Alive?", "Woe's Hollow", "Trojan's Horse"],
  ],
} as const;

const PALETTES: ReadonlyArray<readonly [string, string]> = [
  ["#c3a07c", "#4f3d2d"],
  ["#4b6584", "#141d2b"],
  ["#8e3b46", "#2b1317"],
  ["#76875a", "#2a331f"],
  ["#b8899c", "#4a3342"],
  ["#4f7f7c", "#1c3133"],
  ["#c06a3e", "#3d1d12"],
  ["#9ea3aa", "#3c4046"],
];

const hash = (text: string): number =>
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)).reduce(
    (value, code) => (value * 31 + code) >>> 0,
    7,
  );

const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

type ArtKind = "poster" | "backdrop" | "still";

const ART_SIZES: Readonly<Record<ArtKind, readonly [number, number]>> = {
  poster: [600, 900],
  backdrop: [1920, 1080],
  still: [960, 540],
};

const artSvg = (kind: ArtKind, name: string): string => {
  const [from, to] = PALETTES[hash(name) % PALETTES.length] ?? ["#444444", "#111111"];
  const [width, height] = ART_SIZES[kind];

  const lettering =
    kind === "poster"
      ? `<text x="42" y="840" font-family="Inter Tight, Helvetica, Arial, sans-serif" font-size="66" font-weight="900" letter-spacing="-2" fill="#ffffff" fill-opacity="0.95">${escapeXml(name.toUpperCase())}</text>`
      : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="${String(width)}" height="${String(height)}" fill="url(#g)"/>${lettering}</svg>`;
};

interface ArtJob {
  readonly kind: ArtKind;
  readonly name: string;
  readonly path: string;
}

const drawArt = async (browser: Browser, job: ArtJob): Promise<void> => {
  const [width, height] = ART_SIZES[job.kind];
  const page = await browser.newPage({ viewport: { width, height } });

  try {
    await page.setContent(
      `<html><body style="margin:0">${artSvg(job.kind, job.name)}</body></html>`,
    );
    await mkdir(dirname(job.path), { recursive: true });
    await page.screenshot({ path: job.path, type: "jpeg", quality: 85 });
  } finally {
    await page.close();
  }
};

const silentAudio = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"];

const ENCODINGS: Readonly<Record<Encoding, ReadonlyArray<string>>> = {
  "uhd-hdr": [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=3840x2160:rate=2:duration=1",
    ...silentAudio,
    "-shortest",
    "-vf",
    "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p10le",
    "-x265-params",
    "log-level=error:hdr10=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400",
    "-c:a",
    "eac3",
    "-ac",
    "6",
  ],
  hd: [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1920x1080:rate=2:duration=1",
    ...silentAudio,
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
  ],
};

const encode = async (encoding: Encoding, output: string): Promise<void> => {
  await mkdir(dirname(output), { recursive: true });
  await run(ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    ...ENCODINGS[encoding],
    output,
  ]);
};

const pooled = async (tasks: ReadonlyArray<() => Promise<void>>, limit: number): Promise<void> => {
  const queue = [...tasks];

  const worker = async (): Promise<void> => {
    const task = queue.shift();

    if (task === undefined) return;
    await task();
    await worker();
  };

  await Promise.all(Array.from({ length: limit }, worker));
};

const movieNfo = (movie: FixtureMovie): string => `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>${escapeXml(movie.name)}</title>
  <year>${String(movie.year)}</year>
  <plot>${escapeXml(movie.plot)}</plot>
  <runtime>${String(movie.minutes)}</runtime>
  <mpaa>${movie.certification}</mpaa>
${movie.genres.map((genre) => `  <genre>${escapeXml(genre)}</genre>`).join("\n")}
  <uniqueid type="tmdb" default="true">${movie.tmdb}</uniqueid>
</movie>
`;

const showNfo = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<tvshow>
  <title>${SHOW.name}</title>
  <year>${String(SHOW.year)}</year>
  <plot>${escapeXml(SHOW.plot)}</plot>
  <mpaa>${SHOW.certification}</mpaa>
${SHOW.genres.map((genre) => `  <genre>${escapeXml(genre)}</genre>`).join("\n")}
  <uniqueid type="tmdb" default="true">${SHOW.tmdb}</uniqueid>
</tvshow>
`;

const episodeNfo = (
  season: number,
  episode: number,
  title: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<episodedetails>
  <title>${escapeXml(title)}</title>
  <season>${String(season)}</season>
  <episode>${String(episode)}</episode>
  <runtime>${String(SHOW.minutes)}</runtime>
  <plot>${escapeXml(`${title}: episode ${String(episode)} of season ${String(season)}.`)}</plot>
</episodedetails>
`;

const pad = (value: number): string => String(value).padStart(2, "0");

/** Generates the movies under `moviesRoot` and the show under `showsRoot`. */
export const generateFixtureLibrary = async (
  browser: Browser,
  moviesRoot: string,
  showsRoot: string,
): Promise<void> => {
  const art: Array<ArtJob> = [];
  const media: Array<() => Promise<void>> = [];
  const texts: Array<readonly [string, string]> = [];

  for (const movie of MOVIES) {
    const folder = join(moviesRoot, `${movie.name} (${String(movie.year)})`);

    media.push(() =>
      encode(movie.encoding, join(folder, `${movie.name} (${String(movie.year)}).mkv`)),
    );
    texts.push([join(folder, "movie.nfo"), movieNfo(movie)]);
    art.push(
      { kind: "poster", name: movie.name, path: join(folder, "poster.jpg") },
      { kind: "backdrop", name: movie.name, path: join(folder, "fanart.jpg") },
    );
  }

  const showFolder = join(showsRoot, `${SHOW.name} (${String(SHOW.year)})`);

  texts.push([join(showFolder, "tvshow.nfo"), showNfo()]);
  art.push(
    { kind: "poster", name: SHOW.name, path: join(showFolder, "poster.jpg") },
    { kind: "backdrop", name: SHOW.name, path: join(showFolder, "fanart.jpg") },
  );

  SHOW.seasons.forEach((episodes, seasonIndex) => {
    const season = seasonIndex + 1;

    episodes.forEach((title, episodeIndex) => {
      const episode = episodeIndex + 1;

      const stem = join(
        showFolder,
        `Season ${pad(season)}`,
        `${SHOW.name} - S${pad(season)}E${pad(episode)}`,
      );

      media.push(() => encode("hd", `${stem}.mkv`));
      texts.push([`${stem}.nfo`, episodeNfo(season, episode, title)]);
      art.push({ kind: "still", name: title, path: `${stem}-thumb.jpg` });
    });
  });

  await pooled(media, 4);
  await Promise.all(texts.map(([path, text]) => writeFile(path, text)));
  await pooled(
    art.map((job) => () => drawArt(browser, job)),
    4,
  );
};

/** Writes a one-second 1080p H.264 clip to `output`, for suites that build their own folders. */
export const encodeClip = (output: string): Promise<void> => encode("hd", output);

/** Draws a poster lettered with `name` to `path`, for suites that build their own folders. */
export const drawPoster = (browser: Browser, name: string, path: string): Promise<void> =>
  drawArt(browser, { kind: "poster", name, path });

/** Draws an episode still colored from `name` to `path`, for suites that build their own folders. */
export const drawStill = (browser: Browser, name: string, path: string): Promise<void> =>
  drawArt(browser, { kind: "still", name, path });

/**
 * Fills a development deployment with a realistic synthetic library, acting as the media service
 * would: it claims the scan job, upserts tracks, and finishes the job. No audio or art files exist,
 * so clients must render their artwork placeholders.
 *
 *   node scripts/seed.ts             # admin@music.local / password123, one library, full catalog
 *   node scripts/seed.ts --pending   # only finish pending scan jobs (a stand-in media worker)
 *   node scripts/seed.ts --device "Lucía's iPhone"   # also move playback to a stand-in phone
 *
 * It targets the deployment in `packages/backend/.env.local` and reads the service secret with
 * `convex env get`, so run it from `packages/backend`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { inOrder } from "../convex/lib/sequence.ts";

const ADMIN = { email: "admin@music.local", password: "password123", name: "Lucía" };

const LIBRARY = { name: "Music", path: "/music" };

const BATCH = 50;

interface SeedTrack {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly trackNumber: number;
  readonly discNumber: number;
  readonly year: number;
  readonly genre: string;
  readonly durationMs: number;
  readonly codec: string;
  readonly lossless: boolean;
  readonly bitrate?: number;
  readonly sampleRate?: number;
  readonly bitDepth?: number;
  readonly lyricsFiles: string;
  readonly lyricsReader: number;
  readonly lyrics: ReadonlyArray<never>;
}

type Format = "flac-24-96" | "flac-16-44" | "alac-24-48" | "mp3-320";

interface SeedAlbum {
  readonly artist: string;
  readonly title: string;
  readonly year: number;
  readonly genre: string;
  readonly format: Format;
  readonly tracks: ReadonlyArray<readonly [title: string, duration: string]>;
}

const ALBUMS: ReadonlyArray<SeedAlbum> = [
  {
    artist: "Massive Attack",
    title: "Blue Lines",
    year: 1991,
    genre: "Trip-Hop",
    format: "flac-24-96",
    tracks: [
      ["Safe From Harm", "5:18"],
      ["One Love", "4:48"],
      ["Blue Lines", "4:21"],
      ["Be Thankful for What You've Got", "4:09"],
      ["Five Man Army", "6:04"],
      ["Unfinished Sympathy", "5:08"],
      ["Daydreaming", "4:14"],
      ["Lately", "4:26"],
      ["Hymn of the Big Wheel", "6:36"],
    ],
  },
  {
    artist: "Massive Attack",
    title: "Mezzanine",
    year: 1998,
    genre: "Trip-Hop",
    format: "flac-16-44",
    tracks: [
      ["Angel", "6:18"],
      ["Risingson", "4:58"],
      ["Teardrop", "5:29"],
      ["Inertia Creeps", "5:56"],
      ["Exchange", "4:11"],
      ["Dissolved Girl", "6:06"],
    ],
  },
  {
    artist: "Portishead",
    title: "Dummy",
    year: 1994,
    genre: "Trip-Hop",
    format: "flac-16-44",
    tracks: [
      ["Mysterons", "5:02"],
      ["Sour Times", "4:11"],
      ["Strangers", "3:58"],
      ["It Could Be Sweet", "4:16"],
      ["Wandering Star", "4:51"],
      ["Roads", "5:05"],
      ["Glory Box", "5:01"],
    ],
  },
  {
    artist: "Portishead",
    title: "Third",
    year: 2008,
    genre: "Trip-Hop",
    format: "mp3-320",
    tracks: [
      ["Silence", "4:58"],
      ["Hunter", "3:57"],
      ["Nylon Smile", "3:16"],
      ["Machine Gun", "4:43"],
      ["The Rip", "4:29"],
    ],
  },
  {
    artist: "Radiohead",
    title: "Kid A",
    year: 2000,
    genre: "Alternative",
    format: "flac-16-44",
    tracks: [
      ["Everything in Its Right Place", "4:11"],
      ["Kid A", "4:44"],
      ["The National Anthem", "5:51"],
      ["How to Disappear Completely", "5:56"],
      ["Idioteque", "5:09"],
      ["Motion Picture Soundtrack", "7:01"],
    ],
  },
  {
    artist: "Radiohead",
    title: "In Rainbows",
    year: 2007,
    genre: "Alternative",
    format: "mp3-320",
    tracks: [
      ["15 Step", "3:57"],
      ["Bodysnatchers", "4:02"],
      ["Nude", "4:15"],
      ["Weird Fishes/Arpeggi", "5:18"],
      ["House of Cards", "5:28"],
      ["Reckoner", "4:50"],
    ],
  },
  {
    artist: "Air",
    title: "Moon Safari",
    year: 1998,
    genre: "Electronic",
    format: "flac-24-96",
    tracks: [
      ["La femme d'argent", "7:11"],
      ["Sexy Boy", "4:58"],
      ["All I Need", "4:28"],
      ["Kelly Watch the Stars", "3:44"],
      ["Talisman", "4:16"],
      ["Cherry Blossom Girl", "3:38"],
    ],
  },
  {
    artist: "Tame Impala",
    title: "Currents",
    year: 2015,
    genre: "Psychedelic",
    format: "flac-24-96",
    tracks: [
      ["Let It Happen", "7:47"],
      ["Nangs", "1:47"],
      ["The Moment", "4:15"],
      ["Yes I'm Changing", "4:30"],
      ["Eventually", "5:19"],
      ["The Less I Know the Better", "3:36"],
    ],
  },
  {
    artist: "Frank Ocean",
    title: "Blonde",
    year: 2016,
    genre: "R&B",
    format: "alac-24-48",
    tracks: [
      ["Nikes", "5:14"],
      ["Ivy", "4:09"],
      ["Pink + White", "3:04"],
      ["Solo", "4:17"],
      ["Self Control", "4:09"],
      ["Nights", "5:07"],
      ["White Ferrari", "4:08"],
    ],
  },
  {
    artist: "Daft Punk",
    title: "Random Access Memories",
    year: 2013,
    genre: "Electronic",
    format: "flac-24-96",
    tracks: [
      ["Give Life Back to Music", "4:34"],
      ["The Game of Love", "5:21"],
      ["Giorgio by Moroder", "9:04"],
      ["Instant Crush", "5:37"],
      ["Get Lucky", "6:09"],
      ["Doin' It Right", "4:11"],
    ],
  },
  {
    artist: "The Avalanches",
    title: "Since I Left You",
    year: 2000,
    genre: "Electronic",
    format: "flac-16-44",
    tracks: [
      ["Since I Left You", "4:21"],
      ["Stay Another Season", "1:30"],
      ["Radio", "2:48"],
      ["Frontier Psychiatrist", "4:47"],
      ["Electricity", "4:01"],
    ],
  },
  {
    artist: "DJ Shadow",
    title: "Endtroducing.....",
    year: 1996,
    genre: "Hip-Hop",
    format: "flac-16-44",
    tracks: [
      ["Building Steam With a Grain of Salt", "6:41"],
      ["The Number Song", "4:39"],
      ["Changeling", "7:51"],
      ["Midnight in a Perfect World", "5:00"],
      ["Organ Donor", "1:57"],
    ],
  },
  {
    artist: "Floating Points",
    title: "Promises",
    year: 2021,
    genre: "Jazz",
    format: "flac-24-96",
    tracks: [
      ["Movement 1", "6:31"],
      ["Movement 2", "3:51"],
      ["Movement 3", "1:12"],
      ["Movement 4", "4:41"],
      ["Movement 6", "11:10"],
    ],
  },
];

const FORMATS: Record<Format, Pick<SeedTrack, "codec" | "lossless"> & Partial<SeedTrack>> = {
  "flac-24-96": { codec: "flac", lossless: true, bitDepth: 24, sampleRate: 96_000 },
  "flac-16-44": { codec: "flac", lossless: true, bitDepth: 16, sampleRate: 44_100 },
  "alac-24-48": { codec: "alac", lossless: true, bitDepth: 24, sampleRate: 48_000 },
  "mp3-320": { codec: "mp3", lossless: false, bitrate: 320_000 },
};

const millis = (duration: string): number => {
  const [minutes = "0", seconds = "0"] = duration.split(":");

  return (Number(minutes) * 60 + Number(seconds)) * 1000;
};

const catalog = (): Array<SeedTrack> =>
  ALBUMS.flatMap((album) =>
    album.tracks.map(([title, duration], index) => {
      const number = index + 1;
      const extension = album.format.startsWith("mp3") ? "mp3" : "flac";

      return {
        ...FORMATS[album.format],
        path: `${album.artist}/${album.title}/${String(number).padStart(2, "0")} ${title}.${extension}`,
        size: millis(duration) * 120,
        mtimeMs: Date.UTC(album.year, 0, number),
        title,
        artist: album.artist,
        album: album.title,
        trackNumber: number,
        discNumber: 1,
        year: album.year,
        genre: album.genre,
        durationMs: millis(duration),
        // No lyrics, from no reader: a real scan of these files reads theirs.
        lyricsFiles: "",
        lyricsReader: 0,
        lyrics: [],
      };
    }),
  );

type Wire =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Wire>
  | { readonly [key: string]: Wire };

const signIn = makeFunctionReference<
  "action",
  { provider: string; params: Record<string, string> },
  { tokens?: { token: string } | null }
>("auth:signIn");

const setupStatus = makeFunctionReference<
  "query",
  Record<string, never>,
  { hasUsers: boolean; hasLibraries: boolean }
>("setup:status");

const runCommand = makeFunctionReference<
  "mutation",
  { name: string; args: Record<string, Wire> },
  Record<string, Wire>
>("commands:run");

const readCommand = makeFunctionReference<
  "query",
  { name: string; args: Record<string, Wire> },
  ReadonlyArray<{ id: string; path: string }>
>("commands:read");

const pendingJobs = makeFunctionReference<
  "query",
  { secret: string },
  ReadonlyArray<{ jobId: string; kind: string }>
>("media:pendingJobs");

const claimJob = makeFunctionReference<
  "mutation",
  { secret: string; jobId: string; workerId: string },
  { jobId: string; library: { id: string; path: string; name: string } } | null
>("media:claimJob");

const reportJob = makeFunctionReference<
  "mutation",
  {
    secret: string;
    jobId: string;
    workerId: string;
    done: number;
    total?: number;
    message?: string;
  },
  { cancelled: boolean }
>("media:reportJob");

const upsertTracks = makeFunctionReference<
  "mutation",
  { secret: string; libraryId: string; tracks: ReadonlyArray<SeedTrack> },
  { upserted: number }
>("media:upsertTracks");

const finishJob = makeFunctionReference<
  "mutation",
  { secret: string; jobId: string; workerId: string; status: "done" | "failed"; message?: string },
  null
>("media:finishJob");

const claimRoot = makeFunctionReference<
  "mutation",
  {
    secret: string;
    libraryId: string;
    realPath: string;
    rootIds: ReadonlyArray<string>;
    fsPath: string | null;
    bootId: string | null;
  },
  { ok: boolean }
>("media:claimRoot");

const deploymentUrl = (): string => {
  const line = readFileSync(".env.local", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("CONVEX_SELF_HOSTED_URL="));

  if (line === undefined) throw new Error("CONVEX_SELF_HOSTED_URL is missing from .env.local");

  return line.slice("CONVEX_SELF_HOSTED_URL=".length).trim();
};

const serviceSecret = (): string =>
  execFileSync("pnpm", ["exec", "convex", "env", "get", "MEDIA_SERVICE_SECRET"], {
    encoding: "utf8",
  }).trim();

/** Claims every pending scan job and fills its library with the synthetic catalog. */
const finishPendingJobs = async (client: ConvexHttpClient, secret: string): Promise<number> => {
  const jobs = await client.query(pendingJobs, { secret });
  const tracks = catalog();
  const workerId = "seed";

  const batches = Array.from({ length: Math.ceil(tracks.length / BATCH) }, (_, index) =>
    tracks.slice(index * BATCH, (index + 1) * BATCH),
  );

  let finished = 0;

  // Writes stay in order: each batch updates the album and library counters the next one reads.
  await inOrder(jobs, async ({ jobId }) => {
    const claim = await client.mutation(claimJob, { secret, jobId, workerId });

    if (claim === null) return;
    const prefix = claim.library.path.replace(/\/$/, "");

    // The media service claims a library's folder before a scan; nothing streams without it.
    await client.mutation(claimRoot, {
      secret,
      libraryId: claim.library.id,
      realPath: claim.library.path,
      rootIds: [`seed:${claim.library.id}`],
      fsPath: null,
      bootId: null,
    });

    await inOrder(batches, async (batch, index) => {
      const located = batch.map((track) =>
        Object.assign({}, track, { path: `${prefix}/${track.path}` }),
      );

      await client.mutation(upsertTracks, { secret, libraryId: claim.library.id, tracks: located });

      await client.mutation(reportJob, {
        secret,
        jobId,
        workerId,
        done: Math.min((index + 1) * BATCH, tracks.length),
        total: tracks.length,
        message: located.at(-1)?.path ?? "",
      });
    });

    await client.mutation(finishJob, { secret, jobId, workerId, status: "done" });
    finished += 1;
    console.log(`finished scan of ${claim.library.path}: ${tracks.length} tracks`);
  });

  return finished;
};

const { values } = parseArgs({
  options: { pending: { type: "boolean", default: false }, device: { type: "string" } },
});

const client = new ConvexHttpClient(deploymentUrl());

const secret = serviceSecret();

if (values.pending) {
  const finished = await finishPendingJobs(client, secret);
  console.log(`finished ${finished} pending job(s)`);
} else {
  const status = await client.query(setupStatus, {});
  const flow = status.hasUsers ? "signIn" : "signUp";

  const result = await client.action(signIn, {
    provider: "password",
    params: { email: ADMIN.email, password: ADMIN.password, name: ADMIN.name, flow },
  });

  const token = result.tokens?.token;

  if (token === undefined) throw new Error(`Could not ${flow} as ${ADMIN.email}`);

  client.setAuth(token);
  console.log(`${flow === "signUp" ? "created" : "signed in as"} ${ADMIN.email}`);

  const libraries = await client.query(readCommand, { name: "libraries.list", args: {} });

  if (libraries.some((library) => library.path === LIBRARY.path)) {
    console.log(`library ${LIBRARY.path} already exists`);
  } else {
    await client.mutation(runCommand, { name: "libraries.create", args: { ...LIBRARY } });
    console.log(`created library ${LIBRARY.path}`);
  }

  await finishPendingJobs(client, secret);

  // A stand-in phone for remote-control testing: it checks in and playback moves to it.
  if (values.device !== undefined) {
    const deviceId = "seed-phone";

    await client.mutation(runCommand, {
      name: "devices.heartbeat",
      args: { deviceId, name: values.device, kind: "phone" },
    });

    await client.mutation(runCommand, { name: "playback.transfer", args: { deviceId } });
    console.log(`playback moved to ${values.device}`);
  }
}

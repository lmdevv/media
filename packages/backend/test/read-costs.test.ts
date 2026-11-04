/**
 * What the hot paths cost: seeds a fixed catalog through the public functions, calls each hot
 * query or mutation once, and prints a table of the documents and bytes each read and wrote, as
 * the backend's function log reports them. Every run must seed the same data, so it needs an empty
 * stack and runs only when asked:
 *
 *   scripts/dev-stack.sh destroy && scripts/dev-stack.sh up
 *   MEDIA_STACK_TESTS=1 MEDIA_READ_COSTS=1 pnpm exec vitest run packages/backend/test/read-costs
 */
import { setTimeout as sleep } from "node:timers/promises";

import type { EpisodeId, ProfileId, TitleId } from "@media/contracts/ids";
import { DeviceId } from "@media/contracts/ids";
import { ScannedItem } from "@media/contracts/models/scan";
import { Milliseconds } from "@media/contracts/units";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { Session } from "./harness";
import { run, service, signIn } from "./harness";
import { adminKey, findStack } from "./stack-env";

const MOVIES = 300;

const SHOWS = 30;

const SEASONS = 2;

const EPISODES = 6;

const GENRES = ["Action", "Comedy", "Drama", "Horror", "Sci-Fi", "Romance", "Thriller", "Family"];

const PEOPLE = 200;

const CAST = 8;

const DURATION_MS = 600_000;

const stack = process.env["MEDIA_READ_COSTS"] === "1" ? findStack() : undefined;

const url = stack?.convexUrl ?? "";

const decodeItem = Schema.decodeUnknownSync(ScannedItem);

const scanned = (
  path: string,
  index: number,
  title: { readonly kind: "movie" | "show"; readonly name: string },
  episode: { readonly season: number; readonly episode: number } | null,
): ScannedItem =>
  decodeItem({
    file: {
      path,
      sizeBytes: 1_000_000 + index,
      mtimeMs: 1_760_000_000_000,
      probe: {
        container: "mp4",
        durationMs: DURATION_MS,
        bitRate: 5_000_000,
        video: [
          {
            index: 0,
            codec: "h264",
            profile: "High",
            width: 1920,
            height: 1080,
            frameRate: 23.976,
            bitDepth: 8,
            pixelFormat: "yuv420p",
            hdr: "none",
            bitRate: null,
          },
        ],
        audio: [],
        subtitles: [],
      },
      externalSubtitles: [],
      versionName: null,
    },
    title: {
      kind: title.kind,
      matchKey: `local:${title.name.toLowerCase()}`,
      name: title.name,
      sortName: null,
      year: 1980 + (index % 45),
      overview: `About ${title.name}`,
      tagline: null,
      genres: [GENRES[index % GENRES.length], GENRES[(index * 3 + 1) % GENRES.length]],
      certification: null,
      ageRating: null,
      runtimeMs: DURATION_MS,
      artwork: { poster: `poster-${index}`, backdrop: `backdrop-${index}`, logo: null },
      externalIds: { tmdb: null, imdb: null, tvdb: null },
      matchStatus: "unmatched",
    },
    episode:
      episode === null
        ? null
        : {
            seasonNumber: episode.season,
            episodeNumber: episode.episode,
            name: `Episode ${episode.episode}`,
            overview: null,
            airDate: null,
            runtimeMs: DURATION_MS,
            still: null,
            seasonName: null,
            seasonPoster: null,
          },
  });

const range = (length: number, from = 0): ReadonlyArray<number> =>
  Array.from({ length }, (_, index) => from + index);

const movieItems = range(MOVIES).map((index) =>
  scanned(
    `/bench/movies/movie-${index}.mp4`,
    index,
    { kind: "movie", name: `Movie ${index}` },
    null,
  ),
);

const showItems = range(SHOWS).flatMap((show) =>
  range(SEASONS * EPISODES).map((index) => {
    const season = Math.floor(index / EPISODES) + 1;
    const episode = (index % EPISODES) + 1;

    return scanned(
      `/bench/shows/show-${show}/s${season}e${episode}.mp4`,
      MOVIES + show,
      { kind: "show", name: `Show ${show}` },
      { season, episode },
    );
  }),
);

const batchesOf = <Item>(items: ReadonlyArray<Item>): ReadonlyArray<ReadonlyArray<Item>> =>
  range(Math.ceil(items.length / 100)).map((batch) => items.slice(batch * 100, batch * 100 + 100));

const inOrder = async <Item, Result>(
  items: ReadonlyArray<Item>,
  step: (item: Item, index: number) => Promise<Result>,
  index = 0,
  results: ReadonlyArray<Result> = [],
): Promise<ReadonlyArray<Result>> => {
  const item = items[index];

  if (item === undefined) return results;

  return inOrder(items, step, index + 1, [...results, await step(item, index)]);
};

const person = (n: number) => ({
  name: `Person ${n}`,
  externalIds: { tmdb: `${n + 1}`, imdb: null, tvdb: null },
  profile: null,
});

interface Usage {
  readonly readDocs: number;
  readonly readBytes: number;
  readonly writeDocs: number;
  readonly writeBytes: number;
}

const FunctionLog = Schema.Struct({
  newCursor: Schema.Finite,
  entries: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      identifier: Schema.optionalKey(Schema.String),
      usageStats: Schema.optionalKey(
        Schema.Struct({
          databaseReadDocuments: Schema.Finite,
          databaseReadBytes: Schema.Finite,
          databaseWriteDocuments: Schema.Finite,
          databaseWriteBytes: Schema.Finite,
        }),
      ),
    }),
  ),
});

const decodeLog = Schema.decodeUnknownSync(FunctionLog);

const logSince = async (cursor: number): Promise<typeof FunctionLog.Type> => {
  const response = await fetch(`${url}/api/stream_function_logs?cursor=${cursor}`, {
    headers: { Authorization: `Convex ${adminKey()}` },
  });

  return decodeLog(await response.json());
};

const usageOf = async (identifier: string, cursor: number, attempts = 20): Promise<Usage> => {
  const log = await logSince(cursor);

  const stats = log.entries.find(
    (entry) => entry.kind === "Completion" && entry.identifier === identifier,
  )?.usageStats;

  if (stats !== undefined) {
    return {
      readDocs: stats.databaseReadDocuments,
      readBytes: stats.databaseReadBytes,
      writeDocs: stats.databaseWriteDocuments,
      writeBytes: stats.databaseWriteBytes,
    };
  }

  if (attempts <= 0) throw new Error(`No log entry for ${identifier}`);
  await sleep(250);

  return usageOf(identifier, cursor, attempts - 1);
};

interface Probe {
  readonly label: string;
  readonly identifier: string;
  readonly call: () => Promise<object>;
}

const measure = async (probe: Probe): Promise<readonly [string, Usage]> => {
  const { newCursor } = await logSince(0);

  await probe.call();

  return [probe.label, await usageOf(probe.identifier, newCursor)];
};

const tableOf = (rows: ReadonlyArray<readonly [string, Usage]>): string =>
  [
    "| Path | Docs read | KB read | Docs written | KB written |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows.map(
      ([label, usage]) =>
        `| ${label} | ${usage.readDocs} | ${(usage.readBytes / 1024).toFixed(1)} | ${usage.writeDocs} | ${(usage.writeBytes / 1024).toFixed(1)} |`,
    ),
  ].join("\n");

describe.skipIf(stack === undefined)("read costs", () => {
  it("measures the hot paths", { timeout: 600_000 }, async () => {
    if (stack === undefined) return;

    const owner: Session = await signIn(url, {
      provider: "password",
      params: { flow: "signUp", email: "bench-owner@movies.test", password: "bench-password" },
    });

    const mediaService = await signIn(url, {
      provider: "apikey",
      params: { key: stack.mediaServiceKey },
    });

    const [profile] = await run(owner, "profiles.list", {});

    if (profile === undefined) throw new Error("No profile");
    const profileId: ProfileId = profile.id;

    const library = await run(owner, "libraries.create", {
      name: "Bench",
      kind: "mixed",
      roots: ["/bench"],
    });

    await inOrder(batchesOf([...movieItems, ...showItems]), (items) =>
      service(mediaService, "mediaService.upsertScanned", { libraryId: library.libraryId, items }),
    );

    const titleIdOf = async (name: string): Promise<TitleId> => {
      const results = await run(owner, "titles.search", { profileId, query: name, limit: 50 });
      const found = results.find((title) => title.name === name);

      if (found === undefined) throw new Error(`No title ${name}`);

      return found.id;
    };

    const movieIds = await Promise.all(range(40).map((index) => titleIdOf(`Movie ${index}`)));
    const showIds = await Promise.all(range(6).map((index) => titleIdOf(`Show ${index}`)));

    const startedIds = await Promise.all(
      range(120, 100).map((index) => titleIdOf(`Movie ${index}`)),
    );

    await inOrder(movieIds, (titleId, index) =>
      service(mediaService, "mediaService.applyCredits", {
        titleId,
        episodeId: null,
        credits: [
          ...range(CAST).map((order) => ({
            person: person((index * 7 + order) % PEOPLE),
            kind: "actor" as const,
            role: `Role ${order}`,
            order,
          })),
          { person: person(0), kind: "director" as const, role: null, order: CAST },
        ],
        hash: `credits-${index}`,
      }),
    );

    const episodesOf = (titleId: TitleId) =>
      run(owner, "titles.episodes", { profileId, titleId, seasonNumber: 1 });

    interface Watch {
      readonly profileId: ProfileId;
      readonly titleId: TitleId;
      readonly episodeId: EpisodeId | null;
      readonly positionMs: number;
    }

    const watch = async (target: Watch, index: number): Promise<void> => {
      const session = {
        profileId: target.profileId,
        deviceId: DeviceId.make(`bench-${index}`),
        titleId: target.titleId,
      };

      const started = await run(
        owner,
        "playback.createSession",
        target.episodeId === null ? session : { ...session, episodeId: target.episodeId },
      );

      await run(owner, "playback.endSession", {
        sessionId: started.sessionId,
        positionMs: Milliseconds.make(target.positionMs),
      });
    };

    const showWatches = await Promise.all(
      showIds.map(async (titleId): Promise<ReadonlyArray<Watch>> => {
        const [first, second] = await episodesOf(titleId);

        return first === undefined || second === undefined
          ? []
          : [
              { profileId, titleId, episodeId: first.id, positionMs: DURATION_MS - 1000 },
              { profileId, titleId, episodeId: second.id, positionMs: DURATION_MS / 2 },
            ];
      }),
    );

    const started = await run(owner, "profiles.create", {
      name: "Started",
      avatar: "owl",
      kids: false,
    });

    await inOrder(
      [
        ...movieIds
          .slice(0, 15)
          .map((titleId) => ({ profileId, titleId, episodeId: null, positionMs: DURATION_MS / 3 })),
        ...showWatches.flat(),
        ...startedIds.map((titleId) => ({
          profileId: started.id,
          titleId,
          episodeId: null,
          positionMs: DURATION_MS / 4,
        })),
      ],
      watch,
    );

    await inOrder(movieIds.slice(15, 20), (titleId) =>
      run(owner, "history.markWatched", { profileId, titleId }),
    );
    await inOrder(movieIds.slice(20, 30), (titleId) =>
      run(owner, "myList.add", { profileId, titleId }),
    );

    const [movie] = movieIds;
    const [show] = showIds;

    const director = (
      await run(owner, "people.search", { profileId, query: "Person 0", limit: 5 })
    ).find((found) => found.name === "Person 0");

    if (movie === undefined || show === undefined || director === undefined) {
      throw new Error("Nothing to measure");
    }

    const rescan = (items: ReadonlyArray<ScannedItem>) => () =>
      service(mediaService, "mediaService.upsertScanned", { libraryId: library.libraryId, items });

    const probes: ReadonlyArray<Probe> = [
      {
        label: "titles.home",
        identifier: "titles:home",
        call: () => run(owner, "titles.home", { profileId }),
      },
      {
        label: "history.continueWatching",
        identifier: "history:continueWatching",
        call: () => run(owner, "history.continueWatching", { profileId }),
      },
      {
        label: "titles.list (first page)",
        identifier: "titles:list",
        call: () => run(owner, "titles.list", { profileId, kind: "movie", limit: 40 }),
      },
      {
        label: "titles.list (genre page)",
        identifier: "titles:list",
        call: () => run(owner, "titles.list", { profileId, genre: "Horror", limit: 40 }),
      },
      {
        label: "titles.genres",
        identifier: "titles:genres",
        call: () => run(owner, "titles.genres", { profileId }),
      },
      {
        label: "titles.get (movie)",
        identifier: "titles:get",
        call: () => run(owner, "titles.get", { profileId, titleId: movie }),
      },
      {
        label: "titles.get (show)",
        identifier: "titles:get",
        call: () => run(owner, "titles.get", { profileId, titleId: show }),
      },
      { label: "titles.episodes", identifier: "titles:episodes", call: () => episodesOf(show) },
      {
        label: "titles.similar",
        identifier: "titles:similar",
        call: () => run(owner, "titles.similar", { profileId, titleId: movie }),
      },
      {
        label: "people.get (in 40 titles)",
        identifier: "people:get",
        call: () => run(owner, "people.get", { profileId, personId: director.id }),
      },
      {
        label: "people.requestDetails",
        identifier: "people:requestDetails",
        call: () => run(owner, "people.requestDetails", { profileId, personId: director.id }),
      },
      {
        label: "history.continueWatching (120 started)",
        identifier: "history:continueWatching",
        call: () => run(owner, "history.continueWatching", { profileId: started.id }),
      },
      {
        label: "titles.home (120 started)",
        identifier: "titles:home",
        call: () => run(owner, "titles.home", { profileId: started.id }),
      },
      {
        label: "upsertScanned (100 unchanged movies)",
        identifier: "mediaService:upsertScanned",
        call: rescan(movieItems.slice(0, 100)),
      },
      {
        label: "upsertScanned (100 unchanged episodes)",
        identifier: "mediaService:upsertScanned",
        call: rescan(showItems.slice(0, 100)),
      },
    ];

    const rows = await inOrder(probes, measure);

    process.stdout.write(`${tableOf(rows)}\n`);
    expect(rows).toHaveLength(probes.length);
  });
});

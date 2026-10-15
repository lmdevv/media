/**
 * Puts the generated songs into the dev backend: an admin user, a library on the fixtures folder,
 * and one track per session fixture. Safe to run again.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

import type { TrackId } from "@music/commands/ids";
import { makeMusicClient } from "@music/sdk/client";
import type { MusicClient } from "@music/sdk/client";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { harnessAccount, signIn } from "./auth.ts";
import { backend, fixturesDir } from "./config.ts";
import { generateFixtures, sessionFixtures } from "./fixtures.ts";

const upsertTracks = makeFunctionReference<
  "mutation",
  {
    secret: string;
    libraryId: string;
    tracks: Array<{
      path: string;
      size: number;
      mtimeMs: number;
      title: string;
      artist: string;
      album: string;
      trackNumber: number;
      durationMs: number;
      codec: string;
      lossless: boolean;
    }>;
  },
  { upserted: number }
>("media:upsertTracks");

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

const requireBackend = (): NonNullable<typeof backend> => {
  if (backend === null) {
    throw new Error("No dev backend: run scripts/dev-backend.sh <name> <port> first");
  }

  return backend;
};

const signedInHttp = async (): Promise<ConvexHttpClient> => {
  const { convexUrl } = requireBackend();
  const token = await signIn(convexUrl, harnessAccount.email, harnessAccount.password);
  const http = new ConvexHttpClient(convexUrl);
  http.setAuth(token);

  return http;
};

/** A command client signed in as the harness account, to watch the session from outside. */
export const harnessClient = async (): Promise<MusicClient> =>
  makeMusicClient(await signedInHttp());

/** Seeds the backend and returns the queue of seeded track IDs in fixture order. */
export const seedSession = async (): Promise<ReadonlyArray<TrackId>> => {
  const { mediaSecret } = requireBackend();
  generateFixtures();
  const http = await signedInHttp();
  const music = makeMusicClient(http);
  const libraries = await music.read("libraries.list", {});

  const libraryId =
    libraries.find((library) => library.path === fixturesDir)?.id ??
    (await music.run("libraries.create", { name: "Player fixtures", path: fixturesDir })).libraryId;

  // The media service claims a library's folder before a scan; nothing streams without it.
  await http.mutation(claimRoot, {
    secret: mediaSecret,
    libraryId,
    realPath: fixturesDir,
    rootIds: [`harness:${libraryId}`],
    fsPath: null,
    bootId: null,
  });

  await http.mutation(upsertTracks, {
    secret: mediaSecret,
    libraryId,
    tracks: sessionFixtures.map((fixture, index) => {
      const stats = statSync(join(fixturesDir, fixture.file));

      return {
        path: fixture.file,
        size: stats.size,
        mtimeMs: Math.floor(stats.mtimeMs),
        title: fixture.title,
        artist: "Harness",
        album: "Fixtures",
        trackNumber: index + 1,
        durationMs: fixture.durationMs,
        codec: fixture.codec,
        lossless: fixture.lossless,
      };
    }),
  });

  const page = await music.read("tracks.list", { limit: 200 });

  return sessionFixtures.map((fixture) => {
    const track = page.items.find((item) => item.title === fixture.title);

    if (track === undefined) throw new Error(`Seeded track ${fixture.title} is missing`);

    return track.id;
  });
};

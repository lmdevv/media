/**
 * An in-memory [music] backend for tests: `convex-test` runs the real Convex functions, schema,
 * and dispatcher, and the helpers here sign users in and seed a catalog the way the media service
 * does.
 */
import type { LibraryId, TrackId } from "@music/commands/ids";
import type { Role, Track } from "@music/commands/models";
import { makeMusicClient, type MusicClient } from "@music/sdk/client";
import { convexTest } from "convex-test";
import { vi } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

export const MEDIA_SECRET = "test-media-secret";

process.env["MEDIA_SERVICE_SECRET"] = MEDIA_SECRET;

process.env["STREAM_SIGNING_KEY"] = "test-signing-key";

/** Every function module; convex-test finds the functions root from the `_generated` entries. */
const modules = import.meta.glob(["../convex/**/*.{ts,js}", "!../convex/**/*.d.ts"]);

/**
 * A fresh backend with Convex's per-transaction limits enforced, or tighter ones where a test
 * needs a small catalog to cross them.
 */
export const makeBackend = (limits: { readonly documentsWritten?: number } = {}) =>
  convexTest({ schema, modules, transactionLimits: limits });

export type Backend = ReturnType<typeof makeBackend>;

/** Runs every scheduled function, and those they schedule, to completion. */
export const drainScheduled = async (backend: Backend): Promise<void> => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  try {
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers(), 1000);
  } finally {
    vi.useRealTimers();
  }
};

/** A signed-in user and their typed command client. */
export interface User {
  readonly id: Id<"users">;
  readonly music: MusicClient;
  /** The backend as this user, for calling functions or inline queries directly. */
  readonly as: ReturnType<Backend["withIdentity"]>;
}

/** Creates a user with an auth session and returns a client signed in as them. */
export const signUp = async (
  backend: Backend,
  role: Role,
  email = `${role}-${Math.random().toString(36).slice(2, 8)}@music.test`,
): Promise<User> => {
  const { userId, sessionId } = await backend.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email, name: email.split("@")[0], role });

    const session = await ctx.db.insert("authSessions", {
      userId: id,
      expirationTime: Date.now() + 24 * 60 * 60 * 1000,
    });

    return { userId: id, sessionId: session };
  });

  const signedIn = backend.withIdentity({ subject: `${userId}|${sessionId}` });

  return {
    id: userId,
    as: signedIn,
    music: makeMusicClient({
      query: (reference, args) => signedIn.query(reference, args),
      mutation: (reference, args) => signedIn.mutation(reference, args),
    }),
  };
};

/** The cover every seeded file carries unless it names its own. */
const DEFAULT_ART = "0".repeat(64);

/** One file as the media service reports it; tags not given get defaults. */
export interface SeedFile {
  readonly path: string;
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
  readonly durationMs?: number;
  readonly artHash?: string;
  readonly genre?: string;
  readonly year?: number;
}

/**
 * Claims a library's folder as the media service does before a scan (`media:claimRoot`): at the
 * path it was added with, under a made-up identity no other library shares.
 */
const claimFolder = async (backend: Backend, libraryId: string): Promise<void> => {
  const library = await backend.run(async (ctx) => {
    const id = ctx.db.normalizeId("libraries", libraryId);

    return id === null ? null : ctx.db.get(id);
  });

  if (library === null) throw new Error(`${libraryId} is not a library`);

  const claim = await backend.mutation(api.media.claimRoot, {
    secret: MEDIA_SECRET,
    libraryId: library._id,
    realPath: library.path,
    rootIds: [`test:${library._id}`],
    fsPath: null,
    bootId: null,
  });

  if (!claim.ok) throw new Error(`The claim on ${library.path} was refused: ${claim.error}`);
};

/** Upserts files into a library through `media:upsertTracks`, as a scan does, claiming first. */
export const upsertFiles = async (
  backend: Backend,
  libraryId: string,
  files: ReadonlyArray<SeedFile>,
): Promise<void> => {
  const id = await backend.run(async (ctx) => ctx.db.normalizeId("libraries", libraryId));

  if (id === null) throw new Error(`${libraryId} is not a library ID`);

  await claimFolder(backend, id);

  await backend.mutation(api.media.upsertTracks, {
    secret: MEDIA_SECRET,
    libraryId: id,
    tracks: files.map((file, index) => ({
      path: file.path,
      size: 1000 + index,
      mtimeMs: 1_700_000_000_000,
      title: file.title ?? file.path,
      artist: file.artist ?? "Artist",
      album: file.album ?? "Album",
      durationMs: file.durationMs ?? 180_000,
      codec: "flac",
      lossless: true,
      artHash: file.artHash ?? DEFAULT_ART,
      genre: file.genre,
      year: file.year,
    })),
  });
};

/** Marks files missing through `media:markMissing`, as a scan that no longer finds them does. */
export const markMissing = async (
  backend: Backend,
  libraryId: string,
  paths: ReadonlyArray<string>,
): Promise<void> => {
  const id = await backend.run(async (ctx) => ctx.db.normalizeId("libraries", libraryId));

  if (id === null) throw new Error(`${libraryId} is not a library ID`);
  await backend.mutation(api.media.markMissing, {
    secret: MEDIA_SECRET,
    libraryId: id,
    paths: [...paths],
  });
};

/** Creates a library as `admin` and seeds it with one album of `count` songs. */
export const seedLibrary = async (
  backend: Backend,
  admin: User,
  options: {
    readonly name: string;
    readonly count: number;
    readonly visibility?: "shared" | "private";
    readonly album?: string;
  },
): Promise<{ readonly libraryId: LibraryId; readonly paths: ReadonlyArray<string> }> => {
  const { libraryId } = await admin.music.run("libraries.create", {
    name: options.name,
    path: `/music/${options.name}`,
    visibility: options.visibility ?? "shared",
  });

  const paths = Array.from(
    { length: options.count },
    (_, index) => `${options.name}/${String(index + 1).padStart(4, "0")}.flac`,
  );

  // Batches of 100, as the media service sends them.
  const batches = Array.from({ length: Math.ceil(paths.length / 100) }, (_, batch) =>
    paths.slice(batch * 100, batch * 100 + 100),
  );

  // One batch after another: each one updates the same album and library counters.
  await batches.reduce(async (previous, batch) => {
    await previous;
    await upsertFiles(
      backend,
      libraryId,
      batch.map((path) => ({
        path,
        title: `${options.name} ${path.slice(-9, -5)}`,
        album: options.album ?? `${options.name} Album`,
        artist: `${options.name} Artist`,
      })),
    );
  }, Promise.resolve());

  return { libraryId, paths };
};

/** Every track in the user's readable catalog, by title. */
export const allTracks = async (user: User): Promise<ReadonlyArray<Track>> => {
  const collect = async (
    cursor: string | null,
    seen: ReadonlyArray<Track>,
  ): Promise<ReadonlyArray<Track>> => {
    const page = await user.music.read("tracks.list", { cursor, limit: 200 });
    const tracks = [...seen, ...page.items];

    return page.done ? tracks : collect(page.cursor, tracks);
  };

  return collect(null, []);
};

/** The IDs of tracks whose title starts with `prefix`, in title order. */
export const trackIds = (tracks: ReadonlyArray<Track>, prefix: string): ReadonlyArray<TrackId> =>
  tracks.flatMap((track) => (track.title.startsWith(prefix) ? [track.id] : []));

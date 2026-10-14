import { Match } from "effect";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { randomToken, sha256Hex } from "../lib/crypto";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { normaliseLibraryPath, overlapOf } from "../lib/paths";
import { presentJob, presentLibrary } from "../lib/present";
import { endSession } from "../lib/sessions";
import { canRead } from "../lib/viewer";
import type { Viewer } from "../lib/viewer";
import type { MutationHandlers, QueryHandlers } from "./types";
import { ok } from "./types";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const RECENT_JOBS = 30;

const presentApiKey = (doc: Doc<"apiKeys">) => ({
  id: doc._id,
  name: doc.name,
  prefix: doc.prefix,
  createdAt: doc._creationTime,
  lastUsedAt: doc.lastUsedAt ?? null,
});

const presentUser = (doc: Doc<"users">) => ({
  id: doc._id,
  email: doc.email ?? "",
  name: doc.name ?? null,
  role: doc.role ?? "member",
});

const presentInvite = (doc: Doc<"invites">) => ({
  id: doc._id,
  code: doc.code,
  email: doc.email ?? null,
  role: doc.role,
  createdAt: doc._creationTime,
  expiresAt: doc.expiresAt,
  acceptedAt: doc.acceptedAt ?? null,
});

const activeJob = async (ctx: QueryCtx, libraryId: Id<"libraries">): Promise<Doc<"jobs"> | null> =>
  (await ctx.db
    .query("jobs")
    .withIndex("by_library_status", (q) => q.eq("libraryId", libraryId).eq("status", "running"))
    .first()) ??
  (await ctx.db
    .query("jobs")
    .withIndex("by_library_status", (q) => q.eq("libraryId", libraryId).eq("status", "pending"))
    .first());

/**
 * A library the viewer can see. Admin rights cover shared libraries and the admin's own private
 * ones; another user's private library stays invisible, so it is `not_found` like any other ID.
 */
const visibleLibrary = async (
  ctx: QueryCtx,
  viewer: Viewer,
  id: string,
): Promise<Doc<"libraries">> => {
  const library = await ctx.db.get(tableId(ctx, "libraries", id));

  if (library === null || !canRead(viewer, library._id))
    return fail("not_found", "Library not found");

  return library;
};

/** A job on a library the viewer can see. */
const visibleJob = async (ctx: QueryCtx, viewer: Viewer, id: string): Promise<Doc<"jobs">> => {
  const job = await ctx.db.get(tableId(ctx, "jobs", id));

  if (job === null || !canRead(viewer, job.libraryId)) return fail("not_found", "Job not found");

  return job;
};

/**
 * Fails unless `path` (normalised) stays clear of every library's folder: the same folder, one
 * inside another, or one containing another would index the same files twice. A library the
 * viewer can't see is named only as "another library".
 */
const checkNoOverlap = async (ctx: QueryCtx, viewer: Viewer, path: string): Promise<void> => {
  // Every folder must be compared, and an install has a handful of libraries (`loadViewer` reads
  // them all on every request too).
  const libraries = await ctx.db.query("libraries").collect();

  for (const library of libraries) {
    const other = normaliseLibraryPath(library.path) ?? library.path;
    const overlap = overlapOf(path, other);

    if (overlap === "apart") continue;
    const name = canRead(viewer, library._id) ? `${library.name} (${other})` : "another library";

    return Match.value(overlap).pipe(
      Match.when("same", () => fail("conflict", `${path} is already the folder of ${name}`)),
      Match.when("inside", () => fail("conflict", `${path} is inside the folder of ${name}`)),
      Match.when("contains", () => fail("conflict", `${path} contains the folder of ${name}`)),
      Match.exhaustive,
    );
  }
};

/** Enqueues a scan unless the library already has a pending or running job, which it returns. */
export const enqueueScan = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  createdBy: Id<"users">,
): Promise<Id<"jobs">> => {
  const existing = await activeJob(ctx, libraryId);

  if (existing !== null) return existing._id;

  return ctx.db.insert("jobs", { kind: "scan", status: "pending", libraryId, createdBy, done: 0 });
};

export const adminQueries = {
  "libraries.list": async (ctx, viewer) =>
    Promise.all(
      viewer.libraries.map(async (library) =>
        presentLibrary(library, (await activeJob(ctx, library._id)) !== null),
      ),
    ),

  "jobs.list": async (ctx, viewer) => {
    const jobs = await ctx.db.query("jobs").order("desc").take(RECENT_JOBS);
    const visible = jobs.filter((job) => canRead(viewer, job.libraryId));

    return Promise.all(
      visible.map(async (job) => presentJob(job, await ctx.db.get(job.libraryId))),
    );
  },

  "jobs.get": async (ctx, viewer, args) => {
    const job = await visibleJob(ctx, viewer, args.jobId);

    return presentJob(job, await ctx.db.get(job.libraryId));
  },

  "account.me": async (_ctx, viewer) => presentUser(viewer.user),

  "keys.list": async (ctx, viewer) => {
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", viewer.id))
      .collect();

    return keys.filter((key) => key.revokedAt === undefined).map(presentApiKey);
  },

  "people.list": async (ctx) => {
    const users = await ctx.db.query("users").collect();

    return users.map(presentUser);
  },

  "invites.list": async (ctx) => {
    const invites = await ctx.db.query("invites").order("desc").take(100);
    const now = Date.now();

    // Open invites only: an expired one can no longer be used, so it is not listed as open.
    return invites
      .filter(
        (invite) => !invite.revoked && invite.acceptedBy === undefined && invite.expiresAt > now,
      )
      .map(presentInvite);
  },
} satisfies Partial<QueryHandlers>;

export const adminMutations = {
  "libraries.create": async (ctx, viewer, args) => {
    const path =
      normaliseLibraryPath(args.path) ??
      fail("invalid_args", `Use an absolute folder path, such as /music, not ${args.path}`);

    await checkNoOverlap(ctx, viewer, path);

    const libraryId = await ctx.db.insert("libraries", {
      name: args.name,
      path,
      visibility: args.visibility ?? "shared",
      ownerId: viewer.id,
      trackCount: 0,
      albumCount: 0,
      artistCount: 0,
      durationMs: 0,
    });

    const jobId = await enqueueScan(ctx, libraryId, viewer.id);

    return { libraryId, jobId };
  },

  "libraries.scan": async (ctx, viewer, args) => {
    const library = await visibleLibrary(ctx, viewer, args.libraryId);

    return { jobId: await enqueueScan(ctx, library._id, viewer.id) };
  },

  "libraries.delete": async (ctx, viewer, args) => {
    const library = await visibleLibrary(ctx, viewer, args.libraryId);
    await ctx.db.delete(library._id);

    const open = await Promise.all(
      (["pending", "running"] as const).map((status) =>
        ctx.db
          .query("jobs")
          .withIndex("by_library_status", (q) =>
            q.eq("libraryId", library._id).eq("status", status),
          )
          .collect(),
      ),
    );

    await Promise.all(
      open
        .flat()
        .map((job) => ctx.db.patch(job._id, { status: "cancelled", finishedAt: Date.now() })),
    );

    await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibrary, {
      libraryId: library._id,
    });

    return ok;
  },

  "jobs.cancel": async (ctx, viewer, args) => {
    const job = await visibleJob(ctx, viewer, args.jobId);

    if (job.status === "pending" || job.status === "running") {
      await ctx.db.patch(job._id, { status: "cancelled", finishedAt: Date.now() });
    }

    return ok;
  },

  "account.rename": async (ctx, viewer, args) => {
    await ctx.db.patch(viewer.id, { name: args.name });

    return ok;
  },

  "keys.create": async (ctx, viewer, args) => {
    const key = `mk_${randomToken(40)}`;

    const id = await ctx.db.insert("apiKeys", {
      userId: viewer.id,
      name: args.name,
      prefix: key.slice(0, 10),
      hash: await sha256Hex(key),
    });

    const doc = await ctx.db.get(id);

    if (doc === null) return fail("internal", "The key was not saved");

    return { key, apiKey: presentApiKey(doc) };
  },

  "keys.revoke": async (ctx, viewer, args) => {
    const key = await ctx.db.get(tableId(ctx, "apiKeys", args.apiKeyId));

    if (key === null || key.userId !== viewer.id) return fail("not_found", "Key not found");
    await ctx.db.patch(key._id, { revokedAt: Date.now(), sessionId: undefined });

    if (key.sessionId !== undefined) await endSession(ctx, key.sessionId);

    return ok;
  },

  "invites.create": async (ctx, viewer, args) => {
    const id = await ctx.db.insert("invites", {
      code: randomToken(10),
      email: args.email?.toLowerCase(),
      role: args.role ?? "member",
      createdBy: viewer.id,
      expiresAt: Date.now() + INVITE_TTL_MS,
      revoked: false,
    });

    const invite = await ctx.db.get(id);

    if (invite === null) return fail("internal", "The invite was not saved");

    return presentInvite(invite);
  },

  "invites.revoke": async (ctx, _viewer, args) => {
    const invite = await ctx.db.get(tableId(ctx, "invites", args.inviteId));

    if (invite === null) return fail("not_found", "Invite not found");
    await ctx.db.patch(invite._id, { revoked: true });

    return ok;
  },
} satisfies Partial<MutationHandlers>;

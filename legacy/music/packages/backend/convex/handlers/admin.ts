import {
  assignableRoles,
  can,
  canRemoveLibrary,
  libraryAccessControl,
  widensVisibility,
} from "@music/commands/permissions";
import { isSystemFolder, SYSTEM_FOLDER_MESSAGE } from "@music/commands/system-folders";
import { Match } from "effect";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { randomToken, sha256Hex } from "../lib/crypto";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { firstOverlap, normaliseLibraryPath } from "../lib/paths";
import { ownerLabel, presentJob, presentLibrary } from "../lib/present";
import { endSession } from "../lib/sessions";
import { canManage, canRead, loadPerson, roleOf } from "../lib/viewer";
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
  role: roleOf(doc),
});

const presentInvite = (doc: Doc<"invites">, now: number) => ({
  id: doc._id,
  code: doc.code,
  email: doc.email ?? null,
  role: doc.role,
  status: doc.expiresAt < now ? ("expired" as const) : ("open" as const),
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
 * Whether the viewer may see a library's jobs: to listen to it, or to manage it. Admins also see
 * that other libraries exist (`libraries.list`), but not their jobs, folders, or contents.
 */
const canSee = (viewer: Viewer, library: Doc<"libraries">): boolean =>
  canRead(viewer, library._id) || canManage(viewer, library);

/** A library the viewer manages (see `canManage`), or `not_found`. */
const managedLibrary = async (
  ctx: QueryCtx,
  viewer: Viewer,
  id: string,
): Promise<Doc<"libraries">> => {
  const library = await ctx.db.get(tableId(ctx, "libraries", id));

  if (library === null || !canManage(viewer, library)) {
    return fail("not_found", "Library not found");
  }

  return library;
};

/** What `libraryAccessControl` reads of a library and its owner. */
const accessOf = (library: Doc<"libraries">, owner: Doc<"users"> | null) => ({
  ownerId: library.ownerId,
  ownerRole: owner === null ? null : roleOf(owner),
  ownerSuspended: owner?.suspendedAt !== undefined,
});

/**
 * Fails unless the viewer may make this change to who listens to `library`: its owner, while an
 * admin, any change; the server's owner, once the library's owner isn't one, only a change that
 * lets fewer people in (`libraryAccessControl`).
 */
const checkAccessChange = async (
  ctx: QueryCtx,
  viewer: Viewer,
  library: Doc<"libraries">,
  change: "widen" | "narrow",
): Promise<void> => {
  const control = libraryAccessControl(
    viewer,
    accessOf(library, await ctx.db.get(library.ownerId)),
  );

  if (control === "full" || (control === "narrow" && change === "narrow")) return;

  fail(
    "forbidden",
    control === "narrow"
      ? "Only the library's owner, as an admin, can let more people listen to it"
      : "Only the library's owner can change who listens to it",
  );
};

/** A job on a library the viewer can see. */
const visibleJob = async (ctx: QueryCtx, viewer: Viewer, id: string): Promise<Doc<"jobs">> => {
  const job = await ctx.db.get(tableId(ctx, "jobs", id));
  const library = job === null ? null : await ctx.db.get(job.libraryId);

  if (job === null || library === null || !canSee(viewer, library)) {
    return fail("not_found", "Job not found");
  }

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
  const found = firstOverlap(await ctx.db.query("libraries").collect(), path);

  if (found === null) return;
  const { library, overlap } = found;

  // Neither path is said for a library the viewer can't hear: not even the one they typed, which
  // would confirm a guess at where it lives.
  if (!canRead(viewer, library._id))
    return fail("conflict", "This folder overlaps another library");
  const name = `${library.name} (${normaliseLibraryPath(library.path) ?? library.path})`;

  return Match.value(overlap).pipe(
    Match.when("same", () => fail("conflict", `${path} is already the folder of ${name}`)),
    Match.when("inside", () => fail("conflict", `${path} is inside the folder of ${name}`)),
    Match.when("contains", () => fail("conflict", `${path} contains the folder of ${name}`)),
    Match.exhaustive,
  );
};

const grantOf = (
  ctx: QueryCtx,
  libraryId: Id<"libraries">,
  userId: Id<"users">,
): Promise<Doc<"libraryAccess"> | null> =>
  ctx.db
    .query("libraryAccess")
    .withIndex("by_library", (q) => q.eq("libraryId", libraryId).eq("userId", userId))
    .unique();

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
  "libraries.list": async (ctx, viewer) => {
    // Members see what they can hear; admins also see what they manage but cannot hear.
    const listed = can(viewer.role, "admin")
      ? await ctx.db.query("libraries").collect()
      : viewer.libraries;

    return Promise.all(
      listed.map(async (library) => {
        const owner = await ctx.db.get(library.ownerId);

        return presentLibrary(
          library,
          ownerLabel(owner, viewer.role),
          canRead(viewer, library._id),
          canManage(viewer, library),
          libraryAccessControl(viewer, accessOf(library, owner)),
          (await activeJob(ctx, library._id)) !== null,
        );
      }),
    );
  },

  "libraries.people": async (ctx, viewer, args) => {
    const library = await managedLibrary(ctx, viewer, args.libraryId);

    const grants = await ctx.db
      .query("libraryAccess")
      .withIndex("by_library", (q) => q.eq("libraryId", library._id))
      .collect();

    const users = await Promise.all(grants.map((grant) => ctx.db.get(grant.userId)));

    return users.flatMap((user) => (user === null ? [] : [presentUser(user)]));
  },

  "jobs.list": async (ctx, viewer) => {
    const jobs = await ctx.db.query("jobs").order("desc").take(RECENT_JOBS);

    // Recent jobs share a few libraries; each library and its visibility is read once.
    const seen = new Map<Id<"libraries">, Promise<Doc<"libraries"> | null>>();

    const visibleLibrary = (libraryId: Id<"libraries">): Promise<Doc<"libraries"> | null> => {
      const cached = seen.get(libraryId);

      if (cached !== undefined) return cached;

      const pending = (async () => {
        const library = await ctx.db.get(libraryId);

        return library !== null && canSee(viewer, library) ? library : null;
      })();

      seen.set(libraryId, pending);

      return pending;
    };

    const withLibraries = await Promise.all(
      jobs.map(async (job) => ({ job, library: await visibleLibrary(job.libraryId) })),
    );

    return withLibraries.flatMap(({ job, library }) =>
      library === null ? [] : [presentJob(job, library)],
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

  "invites.list": async (ctx) => {
    const invites = await ctx.db.query("invites").order("desc").take(100);
    const now = Date.now();

    // Unused invites, open and expired: an expired one can't be used, but stays listed (as
    // `expired`) until an admin removes it or the cleanup cron deletes it.
    return invites
      .filter((invite) => !invite.revoked && invite.acceptedBy === undefined)
      .map((invite) => presentInvite(invite, now));
  },
} satisfies Partial<QueryHandlers>;

export const adminMutations = {
  "libraries.create": async (ctx, viewer, args) => {
    const path =
      normaliseLibraryPath(args.path) ??
      fail("invalid_args", `Use an absolute folder path, such as /music, not ${args.path}`);

    if (isSystemFolder(path)) return fail("invalid_args", SYSTEM_FOLDER_MESSAGE);

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
    const library = await managedLibrary(ctx, viewer, args.libraryId);

    return { jobId: await enqueueScan(ctx, library._id, viewer.id) };
  },

  "libraries.update": async (ctx, viewer, args) => {
    const library = await managedLibrary(ctx, viewer, args.libraryId);

    const patch: Partial<Pick<Doc<"libraries">, "name" | "visibility">> = {};

    if (args.name !== undefined) patch.name = args.name;

    if (args.visibility !== undefined && args.visibility !== library.visibility) {
      await checkAccessChange(
        ctx,
        viewer,
        library,
        widensVisibility(library.visibility, args.visibility) ? "widen" : "narrow",
      );
      patch.visibility = args.visibility;
    }

    await ctx.db.patch(library._id, patch);

    return ok;
  },

  "libraries.grant": async (ctx, viewer, args) => {
    const library = await managedLibrary(ctx, viewer, args.libraryId);

    await checkAccessChange(ctx, viewer, library, "widen");
    const user = await loadPerson(ctx, args.userId);

    if (library.visibility === "private") {
      return fail(
        "invalid_args",
        "A private library is only for its owner; make it restricted to add people",
      );
    }

    if (user._id === library.ownerId || (await grantOf(ctx, library._id, user._id)) !== null) {
      return ok;
    }

    await ctx.db.insert("libraryAccess", {
      libraryId: library._id,
      userId: user._id,
      grantedBy: viewer.id,
    });

    return ok;
  },

  "libraries.revoke": async (ctx, viewer, args) => {
    const library = await managedLibrary(ctx, viewer, args.libraryId);

    await checkAccessChange(ctx, viewer, library, "narrow");
    const grant = await grantOf(ctx, library._id, tableId(ctx, "users", args.userId));

    if (grant !== null) await ctx.db.delete(grant._id);

    return ok;
  },

  "libraries.delete": async (ctx, viewer, args) => {
    const library = await managedLibrary(ctx, viewer, args.libraryId);

    // Whoever removes a library could add its folder back as their own; only its owner may.
    if (!canRemoveLibrary(viewer, library)) {
      return fail("forbidden", "Only the library's owner or the server's owner can remove it");
    }

    await ctx.db.delete(library._id);

    // A library has at most one pending and one running job (`enqueueScan`).
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

    // Its songs and its grants, of which there may be many, go in batches after.
    await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibrary, {
      libraryId: library._id,
    });
    await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibraryAccess, {
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
    const role = args.role ?? "member";

    if (!assignableRoles(viewer.role).includes(role)) {
      return fail("forbidden", `You can't invite someone as ${role}`);
    }

    const id = await ctx.db.insert("invites", {
      code: randomToken(10),
      email: args.email?.toLowerCase(),
      role,
      createdBy: viewer.id,
      expiresAt: Date.now() + INVITE_TTL_MS,
      revoked: false,
    });

    const invite = await ctx.db.get(id);

    if (invite === null) return fail("internal", "The invite was not saved");

    return presentInvite(invite, Date.now());
  },

  "invites.revoke": async (ctx, _viewer, args) => {
    const invite = await ctx.db.get(tableId(ctx, "invites", args.inviteId));

    if (invite === null) return fail("not_found", "Invite not found");
    await ctx.db.patch(invite._id, { revoked: true });

    return ok;
  },
} satisfies Partial<MutationHandlers>;

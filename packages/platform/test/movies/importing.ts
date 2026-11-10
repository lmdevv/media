import type { FunctionArgs } from "convex/server";
import { Schema } from "effect";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Member } from "../devices";
import { runServer } from "../service";
import type { CoreStack } from "../stack-env";
import { JobId, answer } from "./catalog";
import type { Lease } from "./catalog";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered this one through `v.id("imports")`, which checks it again whenever a test sends
// it back.
const isImportId = (value: unknown): value is Id<"imports"> => Schema.is(Schema.String)(value);

const ImportId = Schema.declare(isImportId);

const Started = Schema.Struct({ importId: ImportId, jobId: JobId, created: Schema.Boolean });

type Plan = FunctionArgs<typeof api.movies.imports.start>["plan"];

/** A mapped source user of a plan. */
export type PlannedUser = Plan["users"][number];

/** A source library of a plan, with its folders on this host and who saw it. */
export type PlannedLibrary = Plan["libraries"][number];

/** Starts an import of `serverId` for `requester` as the server's import flow does. */
export const startImport = (
  stack: CoreStack,
  requester: Member,
  options: {
    readonly serverId: string;
    readonly source?: "jellyfin" | "plex";
    readonly users?: ReadonlyArray<PlannedUser>;
    readonly libraries?: ReadonlyArray<PlannedLibrary>;
  },
) =>
  runServer(
    stack,
    api.movies.imports.start,
    {
      requestedBy: requester.userId,
      source: options.source ?? "jellyfin",
      serverId: options.serverId,
      serverName: `Server ${options.serverId}`,
      plan: {
        sourceUrl: "http://source.invalid:8096",
        credentials: { version: 1, nonce: "nonce", ciphertext: "sealed" },
        users: [...(options.users ?? [])],
        pathMappings: [],
        libraries: [...(options.libraries ?? [])],
      },
    },
    Started,
  );

const Checkpoint = Schema.Struct({
  phase: Schema.Literals([
    "libraries",
    "scanning",
    "watchState",
    "collections",
    "overrides",
    "done",
  ]),
  unit: Schema.Finite,
  cursor: Schema.Finite,
});

/** Where an import resumes. */
export type Checkpoint = typeof Checkpoint.Type;

const Wrote = answer(Schema.Struct({ done: Schema.Finite, at: Checkpoint }));

const Moved = answer(
  Schema.Struct({ at: Checkpoint, imported: Schema.Struct({ librariesAdded: Schema.Finite }) }),
);

type WatchItem = FunctionArgs<typeof api.movies.imports.writeWatchState>["items"][number];

type CollectionItem = FunctionArgs<typeof api.movies.imports.writeCollections>["items"][number];

type EditItem = FunctionArgs<typeof api.movies.imports.writeEdits>["items"][number];

/** Sends watch items once from `at`, as one call of the import's job does. */
export const writeWatch = (
  stack: CoreStack,
  lease: Lease,
  at: Checkpoint,
  items: ReadonlyArray<WatchItem>,
  unmatched = 0,
  continueAt?: Checkpoint,
) =>
  runServer(
    stack,
    api.movies.imports.writeWatchState,
    continueAt === undefined
      ? { lease, at, unmatched, items: [...items] }
      : { lease, at, continueAt, unmatched, items: [...items] },
    Wrote,
  );

/** Sends collections once from `at`. */
export const writeCollections = (
  stack: CoreStack,
  lease: Lease,
  at: Checkpoint,
  items: ReadonlyArray<CollectionItem>,
) => runServer(stack, api.movies.imports.writeCollections, { lease, at, items: [...items] }, Wrote);

/** Sends title edits once from `at`. */
export const writeEdits = (
  stack: CoreStack,
  lease: Lease,
  at: Checkpoint,
  items: ReadonlyArray<EditItem>,
) => runServer(stack, api.movies.imports.writeEdits, { lease, at, items: [...items] }, Wrote);

/** Moves the import's checkpoint from `at` to `to`. */
export const advance = (stack: CoreStack, lease: Lease, at: Checkpoint, to: Checkpoint) =>
  runServer(stack, api.movies.imports.advance, { lease, at, to, unmatched: 0 }, Moved);

/**
 * Sends every item from `at`, then the rest of what each call left, as the server's job does, and
 * answers each call's `done` and the checkpoint after the last.
 */
export const writeAllWatch = async (
  stack: CoreStack,
  lease: Lease,
  at: Checkpoint,
  items: ReadonlyArray<WatchItem>,
  dones: ReadonlyArray<number> = [],
): Promise<{ readonly dones: ReadonlyArray<number>; readonly at: Checkpoint }> => {
  if (items.length === 0) return { dones, at };

  const wrote = await writeWatch(stack, lease, at, items);

  if (wrote.outcome !== "held") throw new Error(`writeWatchState answered ${wrote.outcome}`);

  if (wrote.value.done === 0) throw new Error("writeWatchState wrote nothing");

  return writeAllWatch(stack, lease, wrote.value.at, items.slice(wrote.value.done), [
    ...dones,
    wrote.value.done,
  ]);
};

/** Covers the planned library at `at` with libraries, as the import's job does. */
export const ensureLibrary = (stack: CoreStack, lease: Lease, at: Checkpoint) =>
  runServer(stack, api.movies.imports.ensureLibrary, { lease, at }, Moved);

/** How many of the import's libraries still have a scan queued or running. */
export const scansPending = (stack: CoreStack, lease: Lease) =>
  runServer(
    stack,
    api.movies.imports.scansPending,
    { lease },
    answer(Schema.Struct({ pending: Schema.Finite })),
  );

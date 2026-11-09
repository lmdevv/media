import { v } from "convex/values";
import type { Infer, ObjectType, PropertyValidators } from "convex/values";

import type { ContentDomain } from "../../../commands/scopes";

export const importSource = v.union(v.literal("jellyfin"), v.literal("plex"));

const tagged = <const Kind extends string, Fields extends PropertyValidators>(
  kind: Kind,
  fields: Fields,
) => v.object({ ...fields, kind: v.literal(kind) });

type Tagged<Kind extends string, Fields extends PropertyValidators> = ReturnType<
  typeof tagged<Kind, Fields>
>;

/**
 * The server's worker pools (ADR 0014). Each kind runs in exactly one, and a pool's cap bounds its
 * kinds together on one server, under each kind's own cap across every worker. `probe` runs only
 * in the stack suite; the server never claims it.
 */
type JobPool = "movies" | "movies.background" | "music" | "server" | "probe";

interface KindPolicy<Payload extends PropertyValidators> {
  /** What enqueue stores, at most a few KiB. A large plan belongs in the domain's own table. */
  readonly payload: Payload;
  /** The server pool whose workers claim this kind. */
  readonly pool: JobPool;
  /** Most jobs of this kind running at once, across every worker. */
  readonly cap: number;
  /**
   * Strikes a job survives before it fails for good. A strike is a failed attempt the worker
   * reported with `retry`, or a lapsed lease whose attempt made no progress.
   */
  readonly maxStrikes: number;
  /**
   * The key a new job collapses into while a job with the same key is queued or running, or null
   * when every enqueue makes a job. The stored key starts with the kind's name, so two kinds never
   * share a key.
   */
  readonly dedupe: ((payload: ObjectType<Payload>) => string) | null;
}

export interface JobKindDef<Kind extends string, Payload, Item> {
  readonly kind: Kind;
  readonly payload: Payload;
  /** The validator of one batched item, or null for a kind whose worker reports done/total. */
  readonly item: Item;
  readonly pool: JobPool;
  readonly cap: number;
  readonly maxStrikes: number;
  /** The dedupe key of a stored payload of this kind, or null when the kind does not dedupe. */
  readonly dedupeKey: (payload: { readonly kind: string }) => string | null;
}

/**
 * Builds a kind entry. A kind with items gets its progress from them: done is the watermark below
 * which every item is complete, and total is the appended count once sealed. Items are small
 * references (a path, an id), because one report appends up to 4,000 of them.
 *
 * @throws Error at module load, a deploy-time defect, when the cap or strike limit is not a whole
 * number of at least 1.
 */
export function defineKind<const Kind extends string, Payload extends PropertyValidators>(
  kind: Kind,
  policy: KindPolicy<Payload> & { readonly item: null },
): JobKindDef<Kind, Tagged<Kind, Payload>, null>;
export function defineKind<
  const Kind extends string,
  Payload extends PropertyValidators,
  Item extends PropertyValidators,
>(
  kind: Kind,
  policy: KindPolicy<Payload> & { readonly item: Item },
): JobKindDef<Kind, Tagged<Kind, Payload>, Tagged<Kind, Item>>;
export function defineKind<
  const Kind extends string,
  Payload extends PropertyValidators,
  Item extends PropertyValidators,
>(
  kind: Kind,
  policy: KindPolicy<Payload> & { readonly item: Item | null },
): JobKindDef<Kind, Tagged<Kind, Payload>, Tagged<Kind, Item> | null> {
  for (const [name, limit] of [
    ["cap", policy.cap],
    ["maxStrikes", policy.maxStrikes],
  ] as const) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`Job kind ${kind} needs a whole ${name} of at least 1; got ${limit}`);
    }
  }

  const { dedupe } = policy;

  // SAFETY: a type predicate, not checked by the compiler. Every caller passes a payload that the
  // stored `jobPayload` validator accepted, a union tagged by `kind`, so a payload whose kind is
  // this one has exactly this kind's fields.
  const isOwn = (payload: {
    readonly kind: string;
  }): payload is ObjectType<Payload> & { readonly kind: string } => payload.kind === kind;

  return {
    kind,
    payload: tagged(kind, policy.payload),
    item: policy.item === null ? null : tagged(kind, policy.item),
    pool: policy.pool,
    cap: policy.cap,
    maxStrikes: policy.maxStrikes,
    dedupeKey: (payload) => {
      if (!isOwn(payload)) {
        throw new Error(`Job kind ${kind} was asked for the dedupe key of a ${payload.kind} job`);
      }

      return dedupe === null ? null : `${kind}:${dedupe(payload)}`;
    },
  };
}

const probeRun = { run: v.string(), n: v.number() };

const LIBRARIES_SCANNING_PER_DOMAIN = 2;

/** The `movies` pool's cap in ADR 0014, which no one of its kinds exceeds on its own. */
const MOVIES_POOL_CAP = 2;

/**
 * The most scrub-thumbnail jobs running across every worker. The server's `movies.background`
 * pool runs `TRICKPLAY_CONCURRENCY` of them, 1 unless set, under this.
 */
const TRICKPLAY_RUNNING_MAX = 8;

const scanKind = <const Kind extends ContentDomain>(kind: Kind) =>
  defineKind(`${kind}.scan`, {
    payload: { libraryId: v.id("libraries") },
    pool: kind,
    item: null,
    cap: LIBRARIES_SCANNING_PER_DOMAIN,
    maxStrikes: 3,
    dedupe: (payload) => payload.libraryId,
  });

export const KINDS = [
  defineKind("probe.capped", {
    payload: probeRun,
    pool: "probe",
    item: null,
    cap: 2,
    maxStrikes: 3,
    dedupe: null,
  }),
  defineKind("probe.wide", {
    payload: probeRun,
    pool: "probe",
    item: null,
    cap: 4,
    maxStrikes: 3,
    dedupe: null,
  }),
  defineKind("probe.items", {
    payload: probeRun,
    pool: "probe",
    item: { n: v.number() },
    cap: 2,
    maxStrikes: 3,
    dedupe: null,
  }),
  defineKind("probe.import", {
    payload: { source: importSource, serverId: v.string() },
    pool: "probe",
    item: null,
    cap: 1,
    maxStrikes: 3,
    dedupe: (payload) => `import:${payload.source}:${payload.serverId}`,
  }),
  scanKind("movies"),
  scanKind("music"),
  defineKind("movies.metadata", {
    payload: {
      titleId: v.id("titles"),
      /** A match an admin chose, which marks the title manual; null refreshes the current one. */
      match: v.union(v.object({ provider: v.literal("tmdb"), providerId: v.string() }), v.null()),
    },
    pool: "movies",
    item: null,
    cap: MOVIES_POOL_CAP,
    maxStrikes: 3,
    /** A refresh joins a queued refresh; an admin's match never folds into one. */
    dedupe: (payload) =>
      `${payload.titleId}:${payload.match === null ? "refresh" : `${payload.match.provider}:${payload.match.providerId}`}`,
  }),
  defineKind("movies.person", {
    payload: { personId: v.id("people") },
    pool: "movies",
    item: null,
    cap: MOVIES_POOL_CAP,
    maxStrikes: 3,
    dedupe: (payload) => payload.personId,
  }),
  defineKind("movies.trickplay", {
    payload: { fileId: v.id("mediaFiles") },
    pool: "movies.background",
    item: null,
    cap: TRICKPLAY_RUNNING_MAX,
    maxStrikes: 3,
    dedupe: (payload) => payload.fileId,
  }),
  defineKind("server.backup", {
    payload: { trigger: v.union(v.literal("nightly"), v.literal("manual")) },
    pool: "server",
    item: null,
    cap: 1,
    maxStrikes: 3,
    dedupe: () => "server",
  }),
] as const;

type KindDef = (typeof KINDS)[number];

export type JobKind = KindDef["kind"];

/** A job kind that scans a library. */
export type ScanKind = Extract<JobKind, `${ContentDomain}.scan`>;

/**
 * The job kind that scans a library of `kind`, the one place a library kind names its scan. It
 * fails to compile while a domain has no scan kind in `KINDS`.
 */
export const scanKindOf = (kind: ContentDomain): ScanKind => `${kind}.scan`;

export const jobKind = v.union(...KINDS.map((def) => v.literal(def.kind)));

export const jobPayload = v.union(...KINDS.map((def) => def.payload));

export type JobPayload = Infer<typeof jobPayload>;

export type PayloadOf<Kind extends JobKind> = Extract<JobPayload, { readonly kind: Kind }>;

export const jobItem = v.union(...KINDS.flatMap((def) => (def.item === null ? [] : [def.item])));

export type JobItem = Infer<typeof jobItem>;

/**
 * The entry for one kind.
 *
 * @throws Error on a name outside `KINDS`, which the stored validators already rule out.
 */
export const kindDef = <Kind extends JobKind>(kind: Kind): Extract<KindDef, { kind: Kind }> => {
  // SAFETY: a type predicate, not checked by the compiler. `KINDS` entries are tagged by their
  // literal `kind`, so the entry whose `kind` equals `kind` is exactly the member this extracts.
  const def = KINDS.find((entry): entry is Extract<KindDef, { kind: Kind }> => entry.kind === kind);

  if (def === undefined) throw new Error(`No job kind ${kind}`);

  return def;
};

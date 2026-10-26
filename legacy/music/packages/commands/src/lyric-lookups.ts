/**
 * The life of an LRCLIB lookup, as Convex (`lyricLookups`) and the media service's in-memory
 * backend both run it. A lookup moves queued -> leased (the media service asking LRCLIB) -> found,
 * instrumental, or miss. A try that failed on its own record waits and queues again, and the fifth
 * is a miss. A try that found LRCLIB unavailable puts the lookup back as it was: an outage pauses
 * every lookup and costs none of them a try. Found and instrumental answers are kept for good; a
 * miss queues again when a song asks after `MISS_RETRY_MS`.
 */
import { Match } from "effect";

/** How urgently a song's lyrics are wanted: it is playing, it was downloaded, or a backfill. */
export type LookupPriority = "play" | "pin" | "backfill";

/** Most urgent first: the order the media service takes queued lookups in. */
export const PRIORITIES: ReadonlyArray<LookupPriority> = ["play", "pin", "backfill"];

interface Pending {
  readonly priority: LookupPriority;
  /** When the lookup was last asked for at its priority; orders the queue. */
  readonly requestedAt: number;
  /** Tries that failed on the lookup's own record. */
  readonly attempts: number;
}

/** Where a lookup is. */
export type LookupState =
  | (Pending & { readonly status: "queued" })
  | (Pending & {
      readonly status: "leased";
      readonly workerId: string;
      readonly leaseUntil: number;
    })
  | (Pending & { readonly status: "waiting"; readonly retryAt: number })
  | { readonly status: "found"; readonly fetchedAt: number; readonly recordId: number }
  | { readonly status: "instrumental"; readonly fetchedAt: number; readonly recordId: number }
  | { readonly status: "miss"; readonly checkedAt: number };

type PendingState = Extract<LookupState, Pending>;

type QueuedState = Extract<LookupState, { readonly status: "queued" }>;

type LeasedState = Extract<LookupState, { readonly status: "leased" }>;

type WaitingState = Extract<LookupState, { readonly status: "waiting" }>;

/**
 * What one try learned: LRCLIB's answer, a record it could not read (`failed`), or that LRCLIB
 * itself was unavailable, with how long the media service paused every request.
 */
export type LookupOutcome =
  | { readonly kind: "found"; readonly recordId: number }
  | { readonly kind: "instrumental"; readonly recordId: number }
  | { readonly kind: "miss" }
  | { readonly kind: "failed" }
  | { readonly kind: "unavailable"; readonly pauseMs: number };

/** Queued lookups the media service sees at once. */
export const LYRIC_QUEUE_SIZE = 10;

/** How long the media service holds a lookup before it counts as stalled. */
const LOOKUP_LEASE_MS = 60_000;

/** Failed tries after which a lookup is a miss. */
const MAX_LOOKUP_ATTEMPTS = 5;

/** How long a miss stands before a song asking for it queues it again. */
export const MISS_RETRY_MS = 30 * 24 * 60 * 60 * 1000;

/** The wait after the first, second, third, and fourth failed try. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

const rank = (priority: LookupPriority): number => PRIORITIES.indexOf(priority);

/**
 * Whether queued lookups at `priority` go newest first. A song playing now goes ahead of songs
 * that played before; downloads and backfills go in the order they were asked for.
 */
export const newestFirst = (priority: LookupPriority): boolean => priority === "play";

/** The order of two queued lookups in the queue: by priority, then by `newestFirst`. */
export const queueOrder = (left: Pending, right: Pending): number =>
  rank(left.priority) - rank(right.priority) ||
  (newestFirst(left.priority)
    ? right.requestedAt - left.requestedAt
    : left.requestedAt - right.requestedAt);

/**
 * The state a request at `priority` made `at` moves a lookup to, or null when it stays. A song
 * with no lookup gets a queued one. A pending lookup rises to a more urgent priority and never
 * falls, and one asked for again at a `newestFirst` priority moves to the front. An answer stands,
 * and a miss queues again once `MISS_RETRY_MS` passed.
 */
export const requested = (
  state: LookupState | null,
  priority: LookupPriority,
  at: number,
): LookupState | null => {
  if (state === null) return { status: "queued", priority, requestedAt: at, attempts: 0 };

  const pending = (current: PendingState): LookupState | null => {
    const raised = rank(priority) < rank(current.priority);

    const again =
      priority === current.priority && newestFirst(priority) && at > current.requestedAt;

    return raised || again ? { ...current, priority, requestedAt: at } : null;
  };

  return Match.value(state).pipe(
    Match.discriminatorsExhaustive("status")({
      found: () => null,
      instrumental: () => null,
      miss: ({ checkedAt }): LookupState | null =>
        at >= checkedAt + MISS_RETRY_MS
          ? { status: "queued", priority, requestedAt: at, attempts: 0 }
          : null,
      queued: pending,
      leased: pending,
      waiting: pending,
    }),
  );
};

/** A queued lookup leased to `workerId` until `LOOKUP_LEASE_MS` after `now`. */
export const leased = (state: QueuedState, workerId: string, now: number): LeasedState => ({
  ...state,
  status: "leased",
  workerId,
  leaseUntil: now + LOOKUP_LEASE_MS,
});

/** A failed try: waiting until the retry delay passed, or a miss after `MAX_LOOKUP_ATTEMPTS`. */
const failedTry = (state: LeasedState, now: number): LookupState => {
  const attempts = state.attempts + 1;
  const delay = RETRY_DELAYS_MS[attempts - 1];

  if (attempts >= MAX_LOOKUP_ATTEMPTS || delay === undefined) {
    return { status: "miss", checkedAt: now };
  }

  const { priority, requestedAt } = state;

  return { status: "waiting", priority, requestedAt, attempts, retryAt: now + delay };
};

/** The state a leased lookup moves to after the try that learned `outcome`. */
export const answered = (state: LeasedState, outcome: LookupOutcome, now: number): LookupState =>
  Match.value(outcome).pipe(
    Match.discriminatorsExhaustive("kind")({
      found: ({ recordId }): LookupState => ({ status: "found", fetchedAt: now, recordId }),
      instrumental: ({ recordId }): LookupState => ({
        status: "instrumental",
        fetchedAt: now,
        recordId,
      }),
      miss: (): LookupState => ({ status: "miss", checkedAt: now }),
      failed: () => failedTry(state, now),
      unavailable: (): LookupState => {
        const { priority, requestedAt, attempts } = state;

        return { status: "queued", priority, requestedAt, attempts };
      },
    }),
  );

/** The state after a lease ran out, as when the media service stopped mid-try: a failed try. */
export const expiredLease = (state: LeasedState, now: number): LookupState => {
  const { priority, requestedAt } = state;
  const attempts = state.attempts + 1;

  return attempts >= MAX_LOOKUP_ATTEMPTS
    ? { status: "miss", checkedAt: now }
    : { status: "queued", priority, requestedAt, attempts };
};

/** A waiting lookup queued again once its retry time came, or null while it has not. */
export const retried = (state: WaitingState, now: number): QueuedState | null => {
  if (now < state.retryAt) return null;
  const { priority, requestedAt, attempts } = state;

  return { status: "queued", priority, requestedAt, attempts };
};

/** When a pause of `pauseMs` from `now` ends, keeping a longer one already in force. */
export const pauseEnd = (current: number | null, now: number, pauseMs: number): number =>
  Math.max(current ?? 0, now + pauseMs);

import type { PlaybackSessionId, UserId } from "@media/contracts/ids";
import { Option } from "effect";

import { makeLimiter } from "./rate-limit.ts";

const SESSION_BUDGET = { burst: 30, perSecond: 0.5 };

const USER_BUDGET = { burst: 60, perSecond: 1 };

/**
 * Whether a failure is the account's own, or a refusal of an authentic token that expired or is for
 * another purpose. Anyone holding an old leaked token can replay it while its session is still
 * renewed, so refusals get session and account buckets of their own and never use up the budget of
 * the session's or the account's real failures.
 */
export type FailureKind = "failure" | "token-refused";

const BUCKETS: Record<FailureKind, { readonly session: string; readonly account: string }> = {
  failure: { session: "session", account: "user" },
  "token-refused": { session: "refused-session", account: "refused" },
};

interface Suppressed {
  readonly sessionId: PlaybackSessionId;
  readonly userId: UserId;
  readonly count: number;
}

/** A budget of failure records per session and per account. */
export interface FailureBudget {
  /** Whether a `kind` failure of `grant`'s session may be logged at `now`; counts it when not. */
  readonly allow: (
    grant: { readonly sessionId: PlaybackSessionId; readonly userId: UserId },
    kind: FailureKind,
    now: number,
  ) => boolean;
  /** The failures counted since the last call, by session, and forgets them. */
  readonly drain: () => ReadonlyArray<Suppressed>;
}

/** A fresh budget, with every bucket full. */
export const makeFailureBudget = (): FailureBudget => {
  const take = makeLimiter();
  const suppressed = new Map<PlaybackSessionId, Suppressed>();

  return {
    allow: ({ sessionId, userId }, kind, now) => {
      const wait = take(
        [
          [`${BUCKETS[kind].session}\u0000${sessionId}`, SESSION_BUDGET],
          [`${BUCKETS[kind].account}\u0000${userId}`, USER_BUDGET],
        ],
        now,
      );

      if (Option.isNone(wait)) return true;

      const count = (suppressed.get(sessionId)?.count ?? 0) + 1;

      suppressed.set(sessionId, { sessionId, userId, count });

      return false;
    },
    drain: () => {
      const counted = [...suppressed.values()];

      suppressed.clear();

      return counted;
    },
  };
};

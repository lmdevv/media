import type { PlaybackSessionId } from "@media/contracts/ids";
import { type StreamId, TranscodeCapacityReached } from "@media/contracts/media-playback";
import { Data, Deferred, Effect, Ref, Scope } from "effect";

/** Who a stream plays for, which sets its priority under a limit (ADR 0007, ADR 0014). */
export type Audience = "household" | "guest";

export interface Claimant {
  readonly streamId: StreamId;
  /** A newer stream of a session is credited the slots its session's older streams hold. */
  readonly sessionId: PlaybackSessionId;
  /**
   * The negotiation that started the stream, kept across resumes; higher is newer. It orders
   * guests: the line serves the lowest first, and the highest running guest is displaced first.
   */
  readonly ticket: number;
  /** False while a new stream is still starting; true for a resume. */
  readonly registered: boolean;
}

/** A held slot, until the scope it was taken for closes. */
export interface Held {
  /**
   * Completes once every slot this holder was credited is free: its session's older registered
   * streams, and the guest it displaced, if any. Start the encoder only after it: a negotiation in
   * between may have begun closing one of them, and nothing else keeps the encoders from
   * overlapping. Once a stream registered no older one can, so a resume waits only for a guest.
   */
  readonly ready: Effect.Effect<void>;
  /**
   * Completes when a household stream takes this slot. The holder then stops its encoder and keeps
   * its session. Never completes for a household holder.
   */
  readonly displaced: Effect.Effect<void>;
  /** Whether a household stream took this slot already; a starting holder then gives up. */
  readonly isDisplaced: Effect.Effect<boolean>;
}

interface Pool {
  readonly limit: number;
  /**
   * Takes a slot until `scope` closes, without waiting. When the limit is reached, takes the slots
   * of the newest guests, registered guests' before starting ones', until it fits. Fails, taking
   * none, when guests' slots are not enough.
   */
  readonly household: (
    scope: Scope.Scope,
    claimant: Claimant,
  ) => Effect.Effect<Held, TranscodeCapacityReached>;
  /**
   * Takes a slot until `scope` closes, first waiting in a line served lowest ticket first while the
   * limit is reached or an older guest waits. A waiter credited its own session's slot fits sooner
   * and is seated ahead of older waiters that do not fit. The wait can be interrupted, and the caller bounds
   * it. Closing `scope` leaves the line, ending the wait, or frees the slot.
   */
  readonly guest: (scope: Scope.Scope, claimant: Claimant) => Effect.Effect<Held>;
  /** Marks `streamId`'s slot registered: its stream may now run an encoder. */
  readonly register: (streamId: StreamId) => Effect.Effect<void>;
}

interface Slot {
  readonly claimant: Claimant;
  readonly audience: Audience;
  readonly freed: Deferred.Deferred<void>;
  readonly displaced: Deferred.Deferred<void>;
  readonly takenBy: StreamId | null;
}

interface Waiter {
  readonly slot: Slot;
  readonly settled: Deferred.Deferred<void>;
}

interface State {
  readonly slots: ReadonlyMap<StreamId, Slot>;
  readonly line: ReadonlyArray<Waiter>;
}

type HouseholdDecision = Data.TaggedEnum<{
  Take: { readonly victims: ReadonlyArray<Slot> };
  Full: {};
}>;

const HouseholdDecision = Data.taggedEnum<HouseholdDecision>();

const creditedTo = (slot: Slot, claimant: Claimant): boolean =>
  slot.claimant.sessionId === claimant.sessionId && slot.claimant.ticket <= claimant.ticket;

/** A taken slot and its taker stand for one encoder; the taken one counts once its taker left. */
const counts = (slot: Slot, claimant: Claimant, slots: ReadonlyMap<StreamId, Slot>): boolean =>
  slot.takenBy === null
    ? !creditedTo(slot, claimant)
    : slot.takenBy !== claimant.streamId && !slots.has(slot.takenBy);

const countedAgainst = (slots: ReadonlyMap<StreamId, Slot>, claimant: Claimant) =>
  [...slots.values()].filter((slot) => counts(slot, claimant, slots));

const newest = (slots: ReadonlyArray<Slot>): Slot | undefined =>
  slots.reduce<Slot | undefined>(
    (found, slot) =>
      found === undefined || slot.claimant.ticket > found.claimant.ticket ? slot : found,
    undefined,
  );

const runningFirst = (guests: ReadonlyArray<Slot>): Slot | undefined =>
  newest(guests.filter((slot) => slot.claimant.registered)) ?? newest(guests);

const decideHousehold = (state: State, claimant: Claimant, limit: number): HouseholdDecision => {
  const counted = countedAgainst(state.slots, claimant);
  const victims: Array<Slot> = [];

  while (counted.length - victims.length >= limit) {
    const victim = runningFirst(
      counted.filter(
        (slot) => slot.audience === "guest" && slot.takenBy === null && !victims.includes(slot),
      ),
    );

    if (victim === undefined) return HouseholdDecision.Full();
    victims.push(victim);
  }

  return HouseholdDecision.Take({ victims });
};

const fillLine = (state: State, limit: number): readonly [ReadonlyArray<Waiter>, State] => {
  const slots = new Map(state.slots);
  const seated: Array<Waiter> = [];
  const line: Array<Waiter> = [];

  for (const waiter of state.line) {
    if (countedAgainst(slots, waiter.slot.claimant).length < limit) {
      slots.set(waiter.slot.claimant.streamId, waiter.slot);
      seated.push(waiter);
    } else {
      line.push(waiter);
    }
  }

  return [seated, { slots, line }];
};

const joinLine = (state: State, waiter: Waiter): State => {
  const ticket = waiter.slot.claimant.ticket;
  const behind = state.line.findIndex((other) => other.slot.claimant.ticket > ticket);
  const at = behind === -1 ? state.line.length : behind;

  return { ...state, line: [...state.line.slice(0, at), waiter, ...state.line.slice(at)] };
};

const remove = (state: State, freed: Deferred.Deferred<void>): State => {
  const slots = new Map(state.slots);

  for (const [streamId, slot] of slots) {
    if (slot.freed === freed) slots.delete(streamId);
  }

  return { slots, line: state.line.filter((waiter) => waiter.slot.freed !== freed) };
};

const settle = (waiters: ReadonlyArray<Waiter>) =>
  Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter.settled, undefined), {
    discard: true,
  });

const slotFor = (claimant: Claimant, audience: Audience) =>
  Effect.all({ freed: Deferred.make<void>(), displaced: Deferred.make<void>() }).pipe(
    Effect.map(({ freed, displaced }): Slot => ({
      claimant,
      audience,
      freed,
      displaced,
      takenBy: null,
    })),
  );

/** Builds a limit of `limit` running encoders, a whole number of at least 1. */
export const make = Effect.fnUntraced(function* (limit: number) {
  const state = yield* Ref.make<State>({ slots: new Map(), line: [] });

  const leave = (slot: Slot) =>
    Ref.modify(state, (current) => fillLine(remove(current, slot.freed), limit)).pipe(
      Effect.flatMap(settle),
      Effect.andThen(Deferred.succeed(slot.freed, undefined)),
    );

  const heldBy = (slot: Slot, victims: ReadonlyArray<Slot>): Held => ({
    ready: Ref.get(state).pipe(
      Effect.flatMap(({ slots }) =>
        Effect.forEach(
          [
            ...[...slots.values()].filter(
              (other) =>
                other.claimant.registered &&
                other.claimant.sessionId === slot.claimant.sessionId &&
                other.claimant.ticket < slot.claimant.ticket,
            ),
            ...victims,
          ],
          (credited) => Deferred.await(credited.freed),
          { discard: true },
        ),
      ),
    ),
    displaced: slot.audience === "guest" ? Deferred.await(slot.displaced) : Effect.never,
    isDisplaced: Deferred.isDone(slot.displaced),
  });

  const household = (scope: Scope.Scope, claimant: Claimant) =>
    Effect.gen(function* () {
      const slot = yield* slotFor(claimant, "household");

      const decision = yield* Ref.modify(state, (current) => {
        const decided = decideHousehold(current, claimant, limit);

        return HouseholdDecision.$match(decided, {
          Take: ({ victims }) => {
            const slots = new Map(current.slots);

            for (const victim of victims) {
              slots.set(victim.claimant.streamId, { ...victim, takenBy: claimant.streamId });
            }

            return [decided, { ...current, slots: slots.set(claimant.streamId, slot) }] as const;
          },
          Full: () => [decided, current] as const,
        });
      });

      return yield* HouseholdDecision.$match(decision, {
        Take: ({ victims }) =>
          Scope.addFinalizer(scope, leave(slot)).pipe(
            Effect.andThen(
              Effect.forEach(victims, (victim) => Deferred.succeed(victim.displaced, undefined), {
                discard: true,
              }),
            ),
            Effect.as(heldBy(slot, victims)),
          ),
        Full: () => Effect.fail(new TranscodeCapacityReached({ limit })),
      });
    }).pipe(Effect.uninterruptible);

  const guest = (scope: Scope.Scope, claimant: Claimant) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const slot = yield* slotFor(claimant, "guest");
        const waiter: Waiter = { slot, settled: yield* Deferred.make<void>() };

        const seated = yield* Ref.modify(state, (current) =>
          fillLine(joinLine(current, waiter), limit),
        );

        yield* settle(seated);

        const finalize = leave(slot).pipe(
          Effect.andThen(Deferred.succeed(waiter.settled, undefined)),
        );

        yield* Scope.addFinalizer(scope, finalize);
        yield* restore(Deferred.await(waiter.settled)).pipe(Effect.onInterrupt(() => finalize));

        return heldBy(slot, []);
      }),
    );

  const register = (streamId: StreamId) =>
    Ref.update(state, (current) => {
      const slot = current.slots.get(streamId);

      return slot === undefined
        ? current
        : {
            ...current,
            slots: new Map(current.slots).set(streamId, {
              ...slot,
              claimant: { ...slot.claimant, registered: true },
            }),
          };
    });

  return { limit, household, guest, register } satisfies Pool;
});

import type { PlaybackSessionId } from "@media/contracts/ids";
import { TranscodeCapacityReached } from "@media/contracts/media-playback";
import { Data, Deferred, Effect, Predicate, Ref, Scope } from "effect";

/** Who a stream plays for, which sets its priority under a limit (ADR 0007, ADR 0014). */
export type Audience = "household" | "guest";

export interface Claimant {
  /** A newer stream of a session takes over the places its session's older streams hold. */
  readonly sessionId: PlaybackSessionId;
  /**
   * The negotiation that started the stream, kept across resumes; higher is newer. It orders
   * guests: the line serves the lowest first, and the highest running guest is displaced first.
   */
  readonly ticket: number;
}

/** A held slot, until the scope it was taken for closes. */
export interface Held {
  /**
   * Completes once the holder may start its encoder, which is while fewer encoders than the limit
   * run, and counts it running from then on. Start the encoder only after it: the slots this one
   * took over may still be stopping theirs. Also completes, counting nothing, once the slot is
   * freed or displaced; the holder then starts no encoder.
   */
  readonly ready: Effect.Effect<void>;
  /**
   * Completes when a household stream takes this slot. The holder then stops its encoder and keeps
   * its session. Never completes for a household holder.
   */
  readonly displaced: Effect.Effect<void>;
  /**
   * Whether a household stream took this slot or it was freed already; a holder not running yet then
   * gives up.
   */
  readonly isDisplaced: Effect.Effect<boolean>;
  /**
   * Takes this slot's place for the holder's next encoder, until `scope` closes, without waiting.
   * This slot keeps counting until it is freed, so the next encoder's `ready` waits for this one's
   * encoder to stop while the limit is reached. Once this slot lost its place, because a household
   * stream or a newer stream of the session took it, the new slot is displaced at once and takes
   * nothing.
   */
  readonly renew: (scope: Scope.Scope) => Effect.Effect<Held>;
}

interface Pool {
  readonly limit: number;
  /**
   * Takes a slot until `scope` closes, without waiting. When the limit is reached, takes the slots
   * of the newest guests, running guests' before starting ones', until it fits. Fails, taking
   * none, when guests' slots are not enough. On a scope that already closed it takes nothing, and
   * the slot it returns is displaced, so its holder starts no encoder.
   */
  readonly household: (
    scope: Scope.Scope,
    claimant: Claimant,
  ) => Effect.Effect<Held, TranscodeCapacityReached>;
  /**
   * Takes a slot until `scope` closes, first waiting in a line served lowest ticket first while the
   * limit is reached or an older guest waits. A waiter whose session already holds a slot fits
   * sooner and is seated ahead of older waiters that do not fit. The wait can be interrupted, and
   * the caller bounds it. Closing `scope` leaves the line, ending the wait, or frees the slot. On a
   * scope that already closed it takes nothing, and the slot it returns is displaced.
   */
  readonly guest: (scope: Scope.Scope, claimant: Claimant) => Effect.Effect<Held>;
}

interface Slot {
  readonly id: number;
  readonly claimant: Claimant;
  readonly audience: Audience;
  readonly freed: Deferred.Deferred<void>;
  readonly displaced: Deferred.Deferred<void>;
  readonly takenOverBy: number | null;
  readonly running: boolean;
}

interface Waiter {
  readonly slot: Slot;
  readonly settled: Deferred.Deferred<void>;
}

interface State {
  readonly slots: ReadonlyMap<number, Slot>;
  readonly line: ReadonlyArray<Waiter>;
}

type Turn = Data.TaggedEnum<{
  Go: {};
  Wait: { readonly until: ReadonlyArray<Deferred.Deferred<void>> };
}>;

const Turn = Data.taggedEnum<Turn>();

type HouseholdDecision = Data.TaggedEnum<{
  Take: { readonly victims: ReadonlyArray<Slot> };
  Full: {};
  Closed: {};
}>;

const HouseholdDecision = Data.taggedEnum<HouseholdDecision>();

const takesOver = (claimant: Claimant, slot: Slot): boolean =>
  slot.takenOverBy === null &&
  slot.claimant.sessionId === claimant.sessionId &&
  slot.claimant.ticket <= claimant.ticket;

const placesAgainst = (slots: ReadonlyMap<number, Slot>, claimant: Claimant) =>
  [...slots.values()].filter((slot) => slot.takenOverBy === null && !takesOver(claimant, slot));

const newest = (slots: ReadonlyArray<Slot>): Slot | undefined =>
  slots.reduce<Slot | undefined>(
    (found, slot) =>
      found === undefined || slot.claimant.ticket > found.claimant.ticket ? slot : found,
    undefined,
  );

const runningFirst = (guests: ReadonlyArray<Slot>): Slot | undefined =>
  newest(guests.filter((slot) => slot.running)) ?? newest(guests);

const decideHousehold = (state: State, claimant: Claimant, limit: number): HouseholdDecision => {
  const places = placesAgainst(state.slots, claimant);
  const victims: Array<Slot> = [];

  while (places.length - victims.length >= limit) {
    const victim = runningFirst(
      places.filter((slot) => slot.audience === "guest" && !victims.includes(slot)),
    );

    if (victim === undefined) return HouseholdDecision.Full();
    victims.push(victim);
  }

  return HouseholdDecision.Take({ victims });
};

const seat = (
  slots: ReadonlyMap<number, Slot>,
  slot: Slot,
  victims: ReadonlyArray<Slot>,
): ReadonlyMap<number, Slot> => {
  const seated = new Map(slots);

  for (const other of slots.values()) {
    if (victims.includes(other) || takesOver(slot.claimant, other)) {
      seated.set(other.id, { ...other, takenOverBy: slot.id });
    }
  }

  return seated.set(slot.id, slot);
};

const fillLine = (state: State, limit: number): readonly [ReadonlyArray<Waiter>, State] => {
  let slots = state.slots;
  const seated: Array<Waiter> = [];
  const line: Array<Waiter> = [];

  for (const waiter of state.line) {
    if (placesAgainst(slots, waiter.slot.claimant).length < limit) {
      slots = seat(slots, waiter.slot, []);
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

const remove = (state: State, id: number): readonly [ReadonlyArray<Slot>, State] => {
  const taker = state.slots.get(id)?.takenOverBy ?? null;
  const toHousehold = taker !== null && state.slots.get(taker)?.audience === "household";
  const slots = new Map<number, Slot>();
  const displaced: Array<Slot> = [];

  for (const slot of state.slots.values()) {
    if (slot.id === id) continue;

    if (slot.takenOverBy === id) {
      if (toHousehold && slot.audience === "guest") displaced.push(slot);
      slots.set(slot.id, { ...slot, takenOverBy: taker });
    } else {
      slots.set(slot.id, slot);
    }
  }

  return [displaced, { slots, line: state.line.filter((waiter) => waiter.slot.id !== id) }];
};

const startIfRoom = (state: State, id: number, limit: number): readonly [Turn, State] => {
  const slot = state.slots.get(id);

  if (slot === undefined || slot.running) return [Turn.Go(), state];
  const running = [...state.slots.values()].filter((other) => other.running);

  if (running.length < limit) {
    return [
      Turn.Go(),
      { ...state, slots: new Map(state.slots).set(id, { ...slot, running: true }) },
    ];
  }

  return [Turn.Wait({ until: [slot.freed, ...running.map((other) => other.freed)] }), state];
};

const settle = (waiters: ReadonlyArray<Waiter>) =>
  Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter.settled, undefined), {
    discard: true,
  });

const displace = (slots: ReadonlyArray<Slot>) =>
  Effect.forEach(slots, (slot) => Deferred.succeed(slot.displaced, undefined), { discard: true });

/** Builds a limit of `limit` running encoders, a whole number of at least 1. */
export const make = Effect.fnUntraced(function* (limit: number) {
  const state = yield* Ref.make<State>({ slots: new Map(), line: [] });
  const ids = yield* Ref.make(0);

  const slotFor = (claimant: Claimant, audience: Audience) =>
    Effect.all({
      id: Ref.getAndUpdate(ids, (id) => id + 1),
      freed: Deferred.make<void>(),
      displaced: Deferred.make<void>(),
    }).pipe(
      Effect.map(({ id, freed, displaced }): Slot => ({
        id,
        claimant,
        audience,
        freed,
        displaced,
        takenOverBy: null,
        running: false,
      })),
    );

  const leave = (slot: Slot) =>
    Ref.modify(state, (current) => {
      const [displaced, left] = remove(current, slot.id);
      const [seated, next] = fillLine(left, limit);

      return [{ displaced, seated }, next] as const;
    }).pipe(
      Effect.flatMap(({ displaced, seated }) =>
        Effect.andThen(displace(displaced), settle(seated)),
      ),
      Effect.andThen(Deferred.succeed(slot.freed, undefined)),
    );

  const ready = (slot: Slot): Effect.Effect<void> =>
    Deferred.isDone(slot.displaced).pipe(
      Effect.flatMap((displaced) =>
        displaced
          ? Effect.succeed(Turn.Go())
          : Ref.modify(state, (current) => startIfRoom(current, slot.id, limit)),
      ),
      Effect.flatMap(
        Turn.$match({
          Go: () => Effect.void,
          Wait: ({ until }) =>
            Effect.raceAll([slot.displaced, ...until].map((one) => Deferred.await(one))).pipe(
              Effect.andThen(Effect.suspend(() => ready(slot))),
            ),
        }),
      ),
    );

  const heldBy = (slot: Slot): Held => ({
    ready: ready(slot),
    displaced: slot.audience === "guest" ? Deferred.await(slot.displaced) : Effect.never,
    isDisplaced: Effect.zipWith(
      Deferred.isDone(slot.displaced),
      Deferred.isDone(slot.freed),
      (displaced, freed) => displaced || freed,
    ),
    renew: (scope) => renew(slot, scope),
  });

  const renew = (previous: Slot, scope: Scope.Scope) =>
    Effect.gen(function* () {
      const slot = yield* slotFor(previous.claimant, previous.audience);

      const renewed = yield* Ref.modify(state, (current) => {
        const place = current.slots.get(previous.id);

        if (
          Predicate.isTagged(scope.state, "Closed") ||
          place === undefined ||
          place.takenOverBy !== null ||
          Deferred.isDoneUnsafe(place.displaced)
        ) {
          return [false, current] as const;
        }

        const slots = new Map(current.slots)
          .set(place.id, { ...place, takenOverBy: slot.id })
          .set(slot.id, slot);

        return [true, { ...current, slots }] as const;
      });

      if (renewed) {
        yield* Scope.addFinalizer(scope, leave(slot));
      } else {
        yield* Deferred.succeed(slot.displaced, undefined);
      }

      return heldBy(slot);
    }).pipe(Effect.uninterruptible);

  const household = (scope: Scope.Scope, claimant: Claimant) =>
    Effect.gen(function* () {
      const slot = yield* slotFor(claimant, "household");

      const decision = yield* Ref.modify(state, (current) => {
        if (Predicate.isTagged(scope.state, "Closed")) {
          return [HouseholdDecision.Closed(), current] as const;
        }

        const decided = decideHousehold(current, claimant, limit);

        return HouseholdDecision.$match(decided, {
          Take: ({ victims }) =>
            [decided, { ...current, slots: seat(current.slots, slot, victims) }] as const,
          Full: () => [decided, current] as const,
          Closed: () => [decided, current] as const,
        });
      });

      return yield* HouseholdDecision.$match(decision, {
        Take: ({ victims }) =>
          Scope.addFinalizer(scope, leave(slot)).pipe(
            Effect.andThen(displace(victims)),
            Effect.as(heldBy(slot)),
          ),
        Full: () => Effect.fail(new TranscodeCapacityReached({ limit })),
        Closed: () => Deferred.succeed(slot.displaced, undefined).pipe(Effect.as(heldBy(slot))),
      });
    }).pipe(Effect.uninterruptible);

  const guest = (scope: Scope.Scope, claimant: Claimant) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const slot = yield* slotFor(claimant, "guest");

        if (Predicate.isTagged(scope.state, "Closed")) {
          yield* Deferred.succeed(slot.displaced, undefined);

          return heldBy(slot);
        }

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

        return heldBy(slot);
      }),
    );

  return { limit, household, guest } satisfies Pool;
});

import { slotHolding } from "@media/sdk/promise";
import type { SharedStore, SharedTransaction } from "@media/sdk/promise";
import { randomUuid } from "@media/ui/lib/secure-context";
import { Brand, Option, Schema } from "effect";

import type { UserId } from "./platform-types";

/**
 * A local name for one sign-in's stored session. A session is written before the app knows whose
 * it is, so its key cannot be named after the person; a slot is promoted to a person once the
 * sign-in says who it is. Never sent to the server.
 */
export type SlotId = string & Brand.Brand<"SlotId">;

const SlotId = Brand.nominal<SlotId>();

const UserId = Brand.nominal<UserId>();

/**
 * Where the core bound a sign-in to this browser's device, its place in the order sessions took
 * it, and what a later number ends, as the core says: `person`, a personal join, ended only by
 * the same person's later join there; `device`, a shared device's tile, ended by any later tile
 * there, whoever's. The core keeps the higher number's session live within that scope.
 */
interface Joined {
  readonly deviceId: string;
  readonly sequence: number;
  readonly scope: "person" | "device";
}

/**
 * A finished sign-in on a slot: whose it is, the session it stored as its token's subject, and
 * where and in what order the core bound it to this browser's device.
 */
export interface SignedIn {
  readonly userId: UserId;
  readonly session: string;
  readonly joined: Joined;
}

/** What this browser holds for every client on the origin. */
export interface Origin {
  /** This browser's device code, `dv_<id>.<secret>`, once a sign-in has enrolled it. */
  readonly device: string | null;
  /** The slot every client on the origin acts as. */
  readonly active: SlotId | null;
  /** Each person who has a session on this browser, and the slot that holds it. */
  readonly people: ReadonlyMap<UserId, SlotId>;
}

/**
 * The origin's account state, in the browser's shared IndexedDB store with the sessions (ADR
 * 0020). Every key name lives in this file; the SDK writes the session keys, this store the rest.
 * Each change is one transaction that decides from what it reads inside it, so it never acts on
 * another tab's stale view. Other tabs hear of it on the store's channel and read again.
 */
export interface OriginStore {
  /** The state as last read; the same object until it changes. */
  readonly read: () => Origin;
  /** Calls `onChange` after the state changes, here or in another tab. */
  readonly subscribe: (onChange: () => void) => () => void;
  /**
   * The SDK's session store, the same IndexedDB store. Without IndexedDB it refuses every read
   * and write, so the client loads no session and signs no one in.
   */
  readonly sessions: SharedStore;
  /** The key a slot's session lives under. */
  readonly sessionKey: (slot: SlotId) => string;
  /**
   * Makes `slot` the one holding the person of `signedIn`, and the active slot; whether it did. It
   * does only while `slot` still holds that very session, and only for the sign-in whose session
   * the core kept: one bound to this device later than any promoted before, by the core's order,
   * whatever order the tabs promote in. No local clock or counter decides. A different slot that
   * held the person before goes, since the core keeps one session per person per device, and so
   * does whoever `slot` held before. Idempotent.
   */
  readonly promote: (slot: SlotId, signedIn: SignedIn) => Promise<boolean>;
  /** Makes `slot` the one every client acts as. */
  readonly activate: (slot: SlotId) => Promise<void>;
  /**
   * Forgets `slot` here, but only while it still holds `session` or nothing: its session, whoever
   * it still held, and the active slot while it is this one, all as the store holds them at that
   * moment. A slot that took another session since, or a person's newer slot, is left alone.
   */
  readonly forget: (slot: SlotId, session: string | null) => Promise<void>;
  /**
   * Keeps `code` as this browser's device code unless one is already kept, and answers the code
   * kept. Two tabs that enroll at once both end up with the first one.
   */
  readonly claimDevice: (code: string) => Promise<string>;
  readonly clearDevice: () => Promise<void>;
}

const DEVICE = "media.device";

const ACTIVE = "media.active";

const PERSON = "media.person.";

const SESSION = "media.session.";

const JOINED = "media.joined.";

/** The last join promoted for a person, and the session it promoted. */
const StoredJoin = Schema.fromJsonString(
  Schema.Struct({ deviceId: Schema.String, sequence: Schema.Int, session: Schema.String }),
);

const decodeJoin = Schema.decodeUnknownOption(StoredJoin);

const encodeJoin = Schema.encodeSync(StoredJoin);

const lastJoin = async (tx: SharedTransaction, userId: UserId) =>
  Option.flatMap(Option.fromNullishOr(await tx.get(`${JOINED}${userId}`)), decodeJoin);

/** The last tile promoted on a shared device, whoever's: the scope a tile's number orders. */
const TILE = "media.tile.";

const StoredTile = Schema.fromJsonString(
  Schema.Struct({ sequence: Schema.Int, session: Schema.String }),
);

const decodeTile = Schema.decodeUnknownOption(StoredTile);

const encodeTile = Schema.encodeSync(StoredTile);

const lastTile = async (tx: SharedTransaction, deviceId: string) =>
  Option.flatMap(Option.fromNullishOr(await tx.get(`${TILE}${deviceId}`)), decodeTile);

const sessionKey = (slot: SlotId): string => `${SESSION}${slot}`;

const EMPTY: Origin = { device: null, active: null, people: new Map() };

const UNAVAILABLE = () =>
  Promise.reject(
    new Error("This browser can't keep a sign-in right now. Reload the page to try again."),
  );

/** The store when IndexedDB cannot open, as in some private modes: it holds nothing. */
const unavailable: SharedStore = {
  read: UNAVAILABLE,
  write: UNAVAILABLE,
  subscribe: () => () => undefined,
};

/** A slot no one has used: a random id. */
export const newSlot = (): SlotId => SlotId(randomUuid());

const originIn = async (tx: SharedTransaction): Promise<Origin> => {
  const keys = await tx.keys();
  const device = await tx.get(DEVICE);
  const active = await tx.get(ACTIVE);

  const people = await Promise.all(
    keys
      .filter((key) => key.startsWith(PERSON))
      .map(async (key) => [key.slice(PERSON.length), await tx.get(key)] as const),
  );

  return {
    device: device ?? null,
    active: active === undefined ? null : SlotId(active),
    people: new Map(
      people.flatMap(([userId, slot]) =>
        slot === undefined ? [] : [[UserId(userId), SlotId(slot)] as const],
      ),
    ),
  };
};

const sameOrigin = (a: Origin, b: Origin): boolean =>
  a.device === b.device &&
  a.active === b.active &&
  a.people.size === b.people.size &&
  [...a.people].every(([userId, slot]) => b.people.get(userId) === slot);

/** Removes a slot nobody uses any more: its session and each of its sessions' tokens. */
const dropSlot = async (tx: SharedTransaction, slot: SlotId): Promise<void> => {
  const prefix = `${sessionKey(slot)}:`;

  const keys = (await tx.keys()).filter(
    (key) => key === sessionKey(slot) || key.startsWith(prefix),
  );

  await Promise.all(keys.map((key) => tx.remove(key)));
};

/**
 * The origin's account state over `shared`, read once before it returns. Without IndexedDB
 * (`null`) it holds nothing and every change fails, so the browser shows signed out.
 */
export const openOriginStore = async (shared: SharedStore | null): Promise<OriginStore> => {
  const listeners = new Set<() => void>();
  let current: Origin = shared === null ? EMPTY : await shared.read(originIn).catch(() => EMPTY);

  const refresh = async () => {
    if (shared === null) return;
    const next = await shared.read(originIn).catch(() => EMPTY);

    if (sameOrigin(current, next)) return;
    current = next;

    for (const listener of listeners) listener();
  };

  shared?.subscribe(() => {
    void refresh();
  });

  const change = async <A>(run: (tx: SharedTransaction) => Promise<A>): Promise<A> => {
    const result = await (shared ?? unavailable).write(run);

    await refresh();

    return result;
  };

  return {
    read: () => current,
    subscribe: (onChange) => {
      listeners.add(onChange);

      return () => {
        listeners.delete(onChange);
      };
    },
    sessions: shared ?? unavailable,
    sessionKey,
    promote: (slot, { userId, session, joined }) =>
      change(async (tx) => {
        const held = await slotHolding(tx, sessionKey(slot));

        if (Option.isNone(held) || held.value.user !== userId || held.value.session !== session) {
          return false;
        }

        const last = await lastJoin(tx, userId);

        // The core's order alone decides; a join on another device is newer, since the browser
        // keeps one device code and a cleared one is never used again.
        // A number is compared within what it ends: a tile against the device's last tile,
        // whoever's; a personal join against the person's last join on the device.
        const kept =
          joined.scope === "device"
            ? Option.match(await lastTile(tx, joined.deviceId), {
                onNone: () => true,
                onSome: (stored) => stored.sequence < joined.sequence,
              })
            : Option.match(last, {
                onNone: () => true,
                onSome: (stored) =>
                  stored.deviceId !== joined.deviceId || stored.sequence < joined.sequence,
              });

        if (!kept) return false;

        const { people } = await originIn(tx);
        const before = people.get(userId);

        await Promise.all(
          [...people].flatMap(([other, slotHeld]) =>
            slotHeld === slot && other !== userId ? [tx.remove(`${PERSON}${other}`)] : [],
          ),
        );

        // The person's older slot goes, unless another sign-in has taken it since: another
        // person's, or one of this person's saved there after the session last promoted.
        if (before !== undefined && before !== slot) {
          const there = await slotHolding(tx, sessionKey(before));

          const stale = Option.match(there, {
            onNone: () => true,
            onSome: (holding) =>
              holding.user === userId &&
              Option.match(last, {
                onNone: () => true,
                onSome: (stored) => stored.session === holding.session,
              }),
          });

          if (stale) await dropSlot(tx, before);
        }

        await tx.set(`${PERSON}${userId}`, slot);
        await tx.set(ACTIVE, slot);

        await tx.set(
          `${JOINED}${userId}`,
          encodeJoin({ deviceId: joined.deviceId, sequence: joined.sequence, session }),
        );

        if (joined.scope === "device") {
          await tx.set(
            `${TILE}${joined.deviceId}`,
            encodeTile({ sequence: joined.sequence, session }),
          );
        }

        return true;
      }),
    activate: (slot) => change((tx) => tx.set(ACTIVE, slot)),
    forget: (slot, session) =>
      change(async (tx) => {
        const held = await slotHolding(tx, sessionKey(slot));

        if (Option.exists(held, (holding) => holding.session !== session)) return;

        const { people, active } = await originIn(tx);

        await Promise.all(
          [...people].flatMap(([person, slotHeld]) =>
            slotHeld === slot ? [tx.remove(`${PERSON}${person}`)] : [],
          ),
        );
        await dropSlot(tx, slot);

        if (active === slot) await tx.remove(ACTIVE);
      }),
    claimDevice: (code) =>
      change(async (tx) => {
        const kept = await tx.get(DEVICE);

        if (kept !== undefined) return kept;
        await tx.set(DEVICE, code);

        return code;
      }),
    clearDevice: () => change((tx) => tx.remove(DEVICE)),
  };
};

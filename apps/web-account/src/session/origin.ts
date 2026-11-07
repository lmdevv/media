import { endedByCore, moveSession, slotHolding } from "@media/sdk/promise";
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
 * Where a personal sign-in joined this browser's device and its number there, under the device
 * epoch the browser kept it at. The core keeps live only the person's highest join on a device,
 * so a promotion compares numbers, but only for the device the browser still keeps.
 */
interface Joined {
  readonly deviceId: string;
  readonly epoch: number;
  readonly sequence: number;
}

/**
 * A finished personal sign-in on a slot: whose it is, the session it stored as its token's
 * subject, and where and in what order the core joined it to this browser's device.
 */
export interface SignedIn {
  readonly userId: UserId;
  readonly session: string;
  readonly joined: Joined;
}

/**
 * A tile the core opened on this shared device: whose, its session, the device, the epoch the
 * browser kept the device at when it asked, the tile's number there, and the slot its sign-in
 * stored it in.
 */
interface OpenedTile {
  readonly userId: UserId;
  readonly session: string;
  readonly deviceId: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly from: SlotId;
}

/**
 * The device this browser keeps: its code, its id, and its epoch, which changes whenever the
 * kept device is set or cleared, so a result obtained for an earlier one is told apart.
 */
interface KeptDevice {
  readonly code: string;
  readonly deviceId: string;
  readonly epoch: number;
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
   * Makes `slot` the one holding the person of a personal sign-in, and the active slot; whether it
   * did. It does only while `slot` still holds that very session, while the browser still keeps
   * the device and epoch the join was made under, and only when the join is higher than the
   * person's last promoted one there: the core keeps one session per person per device, the
   * highest. No local clock or counter decides. The person's older slot goes, and so does whoever
   * `slot` held before. Idempotent.
   */
  readonly promote: (slot: SlotId, signedIn: SignedIn) => Promise<boolean>;
  /**
   * Puts an opened tile in this shared device's one tile slot, and makes it the active slot;
   * whether it did. It does only while the browser still keeps the device and epoch the tile was
   * opened under, and only when the tile's number is higher than the slot's: the core keeps one
   * tile per device, the highest, whoever's. The tile it replaces is recorded as ended and its
   * tokens go, in the same transaction; a tile that lost is recorded as ended and its slot goes.
   */
  readonly installTile: (tile: OpenedTile) => Promise<boolean>;
  /** Makes `slot` the one every client acts as. */
  readonly activate: (slot: SlotId) => Promise<void>;
  /**
   * Forgets `slot` here, but only while it still holds `session` or nothing: its session, whoever
   * it still held, and the active slot while it is this one, all as the store holds them at that
   * moment. A slot that took another session since, or a person's newer slot, is left alone.
   */
  readonly forget: (slot: SlotId, session: string | null) => Promise<void>;
  /**
   * Keeps device `deviceId`, whose code is `code`, unless one is already kept, and answers the
   * device kept with its epoch. Two tabs that enroll at once both end up with the first one.
   */
  readonly claimDevice: (code: string, deviceId: string) => Promise<KeptDevice>;
  /** The device kept now, read in a transaction; null while none is. */
  readonly currentDevice: () => Promise<KeptDevice | null>;
  /**
   * Forgets the kept device and moves to a new epoch; with `epoch`, only while the device kept is
   * still the one of that epoch.
   */
  readonly clearDevice: (epoch?: number) => Promise<void>;
}

const DEVICE = "media.device";

const DEVICE_ID = "media.deviceId";

/** Raised whenever the kept device is set or cleared. */
const DEVICE_EPOCH = "media.deviceEpoch";

const ACTIVE = "media.active";

const PERSON = "media.person.";

const SESSION = "media.session.";

const JOINED = "media.joined.";

/** The last personal join promoted for a person: its device, epoch, number, and session. */
const StoredJoin = Schema.fromJsonString(
  Schema.Struct({
    deviceId: Schema.String,
    epoch: Schema.Int,
    sequence: Schema.Int,
    session: Schema.String,
  }),
);

const decodeJoin = Schema.decodeUnknownOption(StoredJoin);

const encodeJoin = Schema.encodeSync(StoredJoin);

const lastJoin = async (tx: SharedTransaction, userId: UserId) =>
  Option.flatMap(Option.fromNullishOr(await tx.get(`${JOINED}${userId}`)), decodeJoin);

/** The number and session of the tile in a shared device's one tile slot, whoever's. */
const TILE = "media.tile.";

const StoredTile = Schema.fromJsonString(
  Schema.Struct({ sequence: Schema.Int, session: Schema.String }),
);

const decodeTile = Schema.decodeUnknownOption(StoredTile);

const encodeTile = Schema.encodeSync(StoredTile);

const lastTile = async (tx: SharedTransaction, deviceId: string) =>
  Option.flatMap(Option.fromNullishOr(await tx.get(`${TILE}${deviceId}`)), decodeTile);

/**
 * The highest personal join promoted on a device, anyone's. One count orders everything bound to
 * a device, and switching it between personal and shared ends everyone on it, so a tile older
 * than this join, or a join older than the device's tile, is over.
 */
const PERSONAL = "media.personal.";

const highestPersonal = async (tx: SharedTransaction, deviceId: string): Promise<number> =>
  Number((await tx.get(`${PERSONAL}${deviceId}`)) ?? "0") || 0;

const tileNumber = async (tx: SharedTransaction, deviceId: string): Promise<number> =>
  Option.match(await lastTile(tx, deviceId), { onNone: () => 0, onSome: (tile) => tile.sequence });

const sessionKey = (slot: SlotId): string => `${SESSION}${slot}`;

/** A shared device's one tile slot, named by the device. */
const tileSlot = (deviceId: string): SlotId => SlotId(`tile-${deviceId}`);

const epochIn = async (tx: SharedTransaction): Promise<number> =>
  Number((await tx.get(DEVICE_EPOCH)) ?? "0") || 0;

const keptIn = async (tx: SharedTransaction): Promise<KeptDevice | null> => {
  const code = await tx.get(DEVICE);
  const deviceId = await tx.get(DEVICE_ID);

  return code === undefined || deviceId === undefined
    ? null
    : { code, deviceId, epoch: await epochIn(tx) };
};

/** Whether the browser still keeps `deviceId` at `epoch`. */
const stillKept = async (tx: SharedTransaction, deviceId: string, epoch: number) => {
  const kept = await keptIn(tx);

  return kept !== null && kept.deviceId === deviceId && kept.epoch === epoch;
};

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
 * Records the device's tile as ended, and removes its tile slot, the mappings that point at it,
 * and the active slot while it is this one: but only while the slot still holds that tile's
 * session, so another sign-in saved there since stays.
 */
const dropTile = async (tx: SharedTransaction, deviceId: string, at: number): Promise<void> => {
  const slot = tileSlot(deviceId);
  const held = await slotHolding(tx, sessionKey(slot));
  const tile = await lastTile(tx, deviceId);

  const isTile = Option.exists(held, (holding) =>
    Option.exists(tile, (recorded) => recorded.session === holding.session),
  );

  if (!isTile) return;

  const { people, active } = await originIn(tx);

  await Promise.all([
    ...Option.toArray(held).map((holding) =>
      endedByCore(tx, holding.session, sessionKey(slot), at),
    ),
    ...[...people].flatMap(([person, slotHeld]) =>
      slotHeld === slot ? [tx.remove(`${PERSON}${person}`)] : [],
    ),
  ]);
  await dropSlot(tx, slot);

  if (active === slot) await tx.remove(ACTIVE);
};

/**
 * Records as ended every personal session promoted on the tile's device before it, and removes
 * their slots and mappings: the device switched to shared since, which ended them.
 */
const dropPersonalBefore = async (
  tx: SharedTransaction,
  tile: OpenedTile,
  at: number,
): Promise<void> => {
  const { people, active } = await originIn(tx);

  const ended = await Promise.all(
    [...people].map(async ([person, slot]) => {
      const join = await lastJoin(tx, person);
      const held = await slotHolding(tx, sessionKey(slot));

      return Option.match(join, {
        onNone: () => [],
        onSome: (last) =>
          last.deviceId === tile.deviceId &&
          last.sequence < tile.sequence &&
          Option.exists(held, (holding) => holding.session === last.session)
            ? [{ person, slot, session: last.session }]
            : [],
      });
    }),
  );

  await Promise.all(
    ended.flat().map(async ({ person, slot, session }) => {
      await endedByCore(tx, session, sessionKey(slot), at);
      await tx.remove(`${PERSON}${person}`);
      await dropSlot(tx, slot);

      if (active === slot) await tx.remove(ACTIVE);
    }),
  );
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

        // A join made for a device the browser no longer keeps never promotes.
        if (!(await stillKept(tx, joined.deviceId, joined.epoch))) return false;

        // A tile the device took after this join ended it, as switching to shared does.
        if ((await tileNumber(tx, joined.deviceId)) > joined.sequence) return false;

        const last = await lastJoin(tx, userId);

        const kept = Option.match(last, {
          onNone: () => true,
          onSome: (stored) =>
            stored.deviceId !== joined.deviceId ||
            stored.epoch !== joined.epoch ||
            stored.sequence < joined.sequence,
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

        // The tile the device held before this join is over: the device switched to personal.
        if (slot !== tileSlot(joined.deviceId)) await dropTile(tx, joined.deviceId, Date.now());

        await tx.set(`${PERSON}${userId}`, slot);
        await tx.set(ACTIVE, slot);
        await tx.set(`${JOINED}${userId}`, encodeJoin({ ...joined, session }));
        await tx.set(
          `${PERSONAL}${joined.deviceId}`,
          String(Math.max(joined.sequence, await highestPersonal(tx, joined.deviceId))),
        );

        return true;
      }),
    installTile: (tile) =>
      change(async (tx) => {
        const from = sessionKey(tile.from);
        const slot = tileSlot(tile.deviceId);
        const into = sessionKey(slot);
        const now = Date.now();
        const staged = await slotHolding(tx, from);

        if (Option.isNone(staged) || staged.value.session !== tile.session) return false;

        // Newer than the tile there, whoever's, and than any personal join promoted on the device,
        // which a switch to personal after this tile would have ended it for.
        const newer =
          (await stillKept(tx, tile.deviceId, tile.epoch)) &&
          (await tileNumber(tx, tile.deviceId)) < tile.sequence &&
          (await highestPersonal(tx, tile.deviceId)) < tile.sequence;

        // A tile that lost is over on the core already: no answer for it may come back.
        if (!newer) {
          await endedByCore(tx, tile.session, from, now);
          await dropSlot(tx, tile.from);

          return false;
        }

        const replaced = await slotHolding(tx, into);

        await Promise.all(
          Option.toArray(replaced).flatMap((held) =>
            held.session === tile.session ? [] : [endedByCore(tx, held.session, into, now)],
          ),
        );

        await dropSlot(tx, slot);
        await moveSession(tx, from, into, tile.session);
        await dropPersonalBefore(tx, tile, now);

        const { people } = await originIn(tx);

        await Promise.all(
          [...people].flatMap(([person, slotHeld]) =>
            slotHeld === slot ? [tx.remove(`${PERSON}${person}`)] : [],
          ),
        );
        await tx.set(`${PERSON}${tile.userId}`, slot);
        await tx.set(ACTIVE, slot);
        await tx.set(
          `${TILE}${tile.deviceId}`,
          encodeTile({ sequence: tile.sequence, session: tile.session }),
        );

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
    claimDevice: (code, deviceId) =>
      change(async (tx) => {
        const kept = await keptIn(tx);

        if (kept !== null) return kept;

        const epoch = (await epochIn(tx)) + 1;

        await tx.set(DEVICE, code);
        await tx.set(DEVICE_ID, deviceId);
        await tx.set(DEVICE_EPOCH, String(epoch));

        return { code, deviceId, epoch };
      }),
    currentDevice: () => (shared ?? unavailable).read(keptIn),
    clearDevice: (epoch) =>
      change(async (tx) => {
        const kept = await keptIn(tx);

        if (epoch !== undefined && kept?.epoch !== epoch) return;

        // The core no longer knows the device, so the tile it held is over too.
        if (kept !== null) await dropTile(tx, kept.deviceId, Date.now());

        await tx.remove(DEVICE);
        await tx.remove(DEVICE_ID);
        await tx.set(DEVICE_EPOCH, String((await epochIn(tx)) + 1));
      }),
  };
};

import type { Keychain } from "@media/mobile-core/keychain";
import { keychainKey } from "@media/mobile-core/records";
import { Option, Schema } from "effect";

import type { Track } from "../lib/models";
import { seedLocal } from "./local-queue";
import type { LocalQueue } from "./local-queue";

/** Offline plays this phone keeps for later at most, the newest. */
const OFFLINE_PLAYS_KEPT = 2000;

const StoredPlays = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ trackId: Schema.String, playedAt: Schema.Finite })),
);

/** Where the offline plays of `person` on the server at `mediaUrl` wait, one key per pair. */
export const offlinePlaysKey = (mediaUrl: string, person: string): string =>
  keychainKey("music.offlinePlays", mediaUrl, person);

/**
 * The phone's own queue. Its offline plays are also kept in this app's keychain under `playsKey`
 * (`offlinePlaysKey`), so a relaunch or a later outage does not lose them before they reach the
 * server. No key when no one is known.
 */
export class LocalStore {
  #queue: LocalQueue<Track>;
  readonly #listeners = new Set<() => void>();
  readonly #keychain: Keychain;
  readonly #playsKey: string | null;

  constructor(keychain: Keychain, playsKey: string | null) {
    this.#keychain = keychain;
    this.#playsKey = playsKey;

    const plays =
      playsKey === null
        ? []
        : Option.getOrElse(
            Schema.decodeUnknownOption(StoredPlays)(keychain.read(playsKey)),
            () => [],
          );

    this.#queue = { ...seedLocal<Track>(null, () => null), plays };
  }

  getSnapshot = (): LocalQueue<Track> => this.#queue;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  update(change: (queue: LocalQueue<Track>) => LocalQueue<Track>): LocalQueue<Track> {
    const before = this.#queue.plays;
    this.#queue = change(this.#queue);

    if (this.#playsKey !== null && this.#queue.plays !== before) {
      const kept = this.#queue.plays.slice(-OFFLINE_PLAYS_KEPT);

      this.#keychain.write(
        this.#playsKey,
        kept.length === 0 ? null : Schema.encodeSync(StoredPlays)(kept),
      );
    }

    for (const listener of this.#listeners) listener();

    return this.#queue;
  }
}

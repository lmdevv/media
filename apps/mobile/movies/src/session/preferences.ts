import { describeFailure } from "@media/mobile-core/failure";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import type { QueryState } from "@media/sdk/react";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { Alert } from "react-native";

import { loadAppearance, saveAppearance } from "@/lib/appearance";
import type { Appearance } from "@/lib/appearance";
import {
  parsePreferences,
  parseSynced,
  pickSynced,
  serializePreferences,
  serializeSynced,
  settingsChangeOf,
  syncedOf,
} from "@/lib/preferences";
import type { CoreSettings, PlaybackPreferences, SyncedPreferences } from "@/lib/preferences";
import { readValue, writeValue } from "@/lib/secure-storage";

import { usePerson } from "./me";
import { useOffline } from "./offline";

const KEY = "movies.preferences";

/** Where the synced preferences a person's settings last held are kept on this phone. */
const syncedKey = (userId: string): string => `${KEY}.${userId}`;

/** Every preference App Settings shows. */
export interface AppPreferences extends PlaybackPreferences {
  readonly appearance: Appearance;
}

type Synced = Partial<SyncedPreferences>;

/** What the phone holds, replaced as a whole on every change. */
interface Held {
  /** This phone's own preferences, and its last choice of the synced ones for whoever is signed in. */
  readonly local: AppPreferences;
  /** The synced preferences each person's settings last held, read from the keychain on first use. */
  readonly known: ReadonlyMap<string, Synced>;
  /** Synced preferences sent to the server and not yet answered, by person, oldest first. */
  readonly pending: ReadonlyMap<string, ReadonlyArray<Synced>>;
}

let held: Held = {
  local: { appearance: loadAppearance(), ...parsePreferences(readValue(KEY)) },
  known: new Map(),
  pending: new Map(),
};

const pendingIn = (from: Held, userId: string): Synced => {
  const all: Synced = {};

  for (const sent of from.pending.get(userId) ?? []) Object.assign(all, sent);

  return all;
};

const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

const readHeld = (): Held => held;

const changed = (): void => {
  for (const listener of listeners) listener();
};

const storedSynced = (userId: string): Synced => parseSynced(readValue(syncedKey(userId)));

/** What `userId`'s settings last held, from the keychain when this launch has not read them yet. */
const knownIn = (from: Held, userId: string): Synced =>
  from.known.get(userId) ?? storedSynced(userId);

/** As `knownIn`, keeping what the keychain held for the next read. */
const knownFor = (userId: string): Synced => {
  const cached = held.known.get(userId);

  if (cached !== undefined) return cached;
  const stored = storedSynced(userId);

  held = { ...held, known: new Map(held.known).set(userId, stored) };

  return stored;
};

const sameSynced = (left: Synced, right: Synced): boolean =>
  serializeSynced(left) === serializeSynced(right);

/** Keeps `next` as what `userId`'s settings hold, here and in the keychain. */
const remember = (userId: string, next: Synced): void => {
  if (sameSynced(knownFor(userId), next)) return;

  held = { ...held, known: new Map(held.known).set(userId, next) };
  writeValue(syncedKey(userId), serializeSynced(next));
  changed();
};

/** Stops waiting on `sent`, the server having answered it. */
const settle = (userId: string, sent: Synced): void => {
  const left = (held.pending.get(userId) ?? []).filter((each) => each !== sent);
  const pending = new Map(held.pending);

  if (left.length === 0) pending.delete(userId);
  else pending.set(userId, left);

  held = { ...held, pending };
  changed();
};

const setLocal = (change: Partial<AppPreferences>): void => {
  const { appearance, ...playback } = { ...held.local, ...change };

  if (appearance !== held.local.appearance) saveAppearance(appearance);

  writeValue(KEY, serializePreferences(playback));
  held = { ...held, local: { appearance, ...playback } };
  changed();
};

/** The person's settings on the server; never asked for offline, so loading for good then. */
const useSettings = (offline: boolean): QueryState<CoreSettings> => {
  const platform = usePlatform();

  return usePlatformQuery(platform.core.settings.get, ...(offline ? (["skip"] as const) : []));
};

/** Every preference, and whether the person's settings on the server have answered. */
export interface PreferencesState {
  readonly preferences: AppPreferences;
  /**
   * Whether the server's answer is in: true once it answered or failed, and offline. Until then the
   * synced preferences are the ones it last held, or this phone's.
   */
  readonly settled: boolean;
}

/**
 * Every preference, re-rendering when one changes: the phone's own, under the person's settings on
 * the server (audio and subtitle languages, autoplay, and this device's quality). Until the server
 * answers, and offline, the synced ones are those it last held for the person.
 */
const usePreferencesState = (): PreferencesState => {
  const { userId } = usePerson();
  const offline = useOffline() !== null;
  const settings = useSettings(offline);
  const phone = useSyncExternalStore(subscribe, readHeld, readHeld);
  const live = settings.status === "success" ? settings.data : null;

  useEffect(() => {
    if (live !== null) remember(userId, syncedOf(live));
  }, [live, userId]);

  const preferences = useMemo(
    (): AppPreferences => ({
      ...phone.local,
      ...(live === null ? knownIn(phone, userId) : syncedOf(live)),
      ...pendingIn(phone, userId),
    }),
    [phone, live, userId],
  );

  return { preferences, settled: offline || settings.status !== "loading" };
};

/**
 * Every preference, re-rendering when one changes. The player reads the playback ones (quality,
 * mobile data, languages, audio description, autoplay) from here when it starts.
 */
export const usePreferences = (): AppPreferences => usePreferencesState().preferences;

/**
 * Changes some preferences. The phone keeps its own at once and applies a new appearance at once;
 * the synced ones also go to the person's settings on the server, and a refusal puts them back and
 * says why.
 */
export const useUpdatePreferences = (): ((change: Partial<AppPreferences>) => void) => {
  const platform = usePlatform();
  const { userId } = usePerson();
  const settings = useSettings(useOffline() !== null);
  const onDevice = !(settings.status === "success" && settings.data.device === null);

  return useCallback(
    (change: Partial<AppPreferences>) => {
      setLocal(change);

      const synced = pickSynced(change);
      const request = settingsChangeOf(synced, onDevice);

      if (request === null) return;

      const before = knownFor(userId);

      held = {
        ...held,
        pending: new Map(held.pending).set(userId, [...(held.pending.get(userId) ?? []), synced]),
      };
      remember(userId, { ...before, ...synced });

      platform.core.settings.set(request).then(
        () => settle(userId, synced),
        (cause: unknown) => {
          remember(userId, before);
          settle(userId, synced);
          Alert.alert("Couldn’t Save Setting", describeFailure(cause));
        },
      );
    },
    [platform, userId, onDevice],
  );
};

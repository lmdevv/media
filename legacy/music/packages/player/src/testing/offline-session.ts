/**
 * Test doubles for a device that plays its own session: a small library, the device, a clock you
 * move by hand, a Convex deployment that runs commands in the order they were sent and answers
 * nothing while the connection is down or the server is held up, and a store that keeps sessions
 * as JSON and parses them back.
 */
import { AlbumId, ArtistId, DeviceId, QueueItemId, TrackId } from "@music/commands/ids";
import { PlaybackState, StreamProfile } from "@music/commands/models";
import type { QueueEntry, Track } from "@music/commands/models";
import { makeMusicClient } from "@music/sdk/client";
import type { CommandTransport, MusicClient } from "@music/sdk/client";
import { Schema, Struct } from "effect";

import { LocalSessionState } from "../local-session";
import type { LocalDevice } from "../local-session";
import type {
  ConnectionSignal,
  RouterClock,
  SessionStore,
  StoredSessions,
} from "../session-router";

/** The device under test. */
export const phone: LocalDevice = { id: DeviceId.make("phone"), name: "Phone", kind: "phone" };

/** Another of the listener's devices. */
export const laptop = DeviceId.make("laptop");

/** The songs of the test library, by ID. */
export const songIds = ["a", "b", "c", "d", "e", "f"] as const;

/** One song of the test library. */
export type SongId = (typeof songIds)[number];

const song = (id: SongId): Track => ({
  id: TrackId.make(id),
  title: id,
  artist: "Artist",
  artistId: ArtistId.make("artist"),
  album: "Album",
  albumId: AlbumId.make("album"),
  trackNumber: null,
  discNumber: null,
  durationMs: 180_000 + songIds.indexOf(id) * 7000,
  codec: "AAC",
  lossless: false,
  bitrate: null,
  sampleRate: null,
  bitDepth: null,
  artUrl: null,
  liked: true,
});

const library = new Map<string, Track>(songIds.map((id) => [id, song(id)]));

/** What `playable` answers on a device that holds copies of `downloaded`. */
export const holding =
  (downloaded: Iterable<string>) =>
  (trackId: TrackId): Track | null => {
    const held = new Set(downloaded);

    return held.has(trackId) ? (library.get(trackId) ?? null) : null;
  };

/** The queue entry for `id` at `position`, as the server lists it. */
const queueEntry = (id: SongId, position: number): QueueEntry =>
  Struct.assign(song(id), {
    itemId: QueueItemId.make(String(position + 1)),
    addedBy: null,
    autoplay: false,
  });

/** The server's session playing `queue` on the phone, from its start, unless `overrides` say. */
export const sessionOf = (
  queue: ReadonlyArray<SongId>,
  overrides: Partial<PlaybackState> = {},
): PlaybackState => ({
  activeDevice: { id: phone.id, name: phone.name, kind: phone.kind, lastSeenAt: 0, online: true },
  positionMs: 0,
  playing: true,
  updatedAt: 1_000_000,
  volume: 1,
  following: false,
  queue: queue.map(queueEntry),
  index: 0,
  shuffle: false,
  repeat: "off",
  autoplay: true,
  ...overrides,
});

/** A clock that moves only when the test moves it, running timers that come due in order. */
export const manualClock = (
  start = 1_000_000,
): RouterClock & { readonly advance: (ms: number) => void } => {
  let now = start;
  const timers = new Set<{ readonly at: number; readonly callback: () => void }>();

  return {
    now: () => now,
    after: (ms, callback) => {
      const timer = { at: now + ms, callback };

      timers.add(timer);

      return () => {
        timers.delete(timer);
      };
    },
    advance: (ms) => {
      now += ms;
      const due = [...timers].filter((timer) => timer.at <= now).toSorted((a, b) => a.at - b.at);

      for (const timer of due) {
        timers.delete(timer);
        timer.callback();
      }
    },
  };
};

/** Where the server signs streams: an address nothing answers at, as when the media is down. */
export const unreachableMedia = "http://127.0.0.1:1/media";

const decodeStreamArgs = Schema.decodeUnknownSync(
  Schema.Struct({ trackId: Schema.String, profile: StreamProfile }),
);

/** One command the server ran. */
interface Ran {
  readonly name: string;
  readonly args: unknown;
}

/**
 * A Convex deployment as a device meets it. Commands run in the order they were sent, and none
 * runs or is answered while the connection is down or the server is held up; they wait and run
 * once it is back, as Convex sends a client's mutations again in order after a reconnect. It
 * signs streams on `unreachableMedia` and answers no other query.
 */
export const recordingServer = () => {
  const ran: Array<Ran> = [];
  const waiting: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const state = { connected: true, held: false, adopt: true, failures: 0 };

  const flush = (): void => {
    while (state.connected && !state.held) {
      const next = waiting.shift();

      if (next === undefined) return;
      next();
    }
  };

  const transport: CommandTransport = {
    query: async (_reference, { name, args }) => {
      if (name !== "stream.url") throw new Error(`This server answers no ${name}`);
      const { trackId, profile } = decodeStreamArgs(args);

      return {
        trackId,
        url: `${unreachableMedia}/stream/${trackId}?p=${profile}`,
        profile,
        expiresAt: 4_000_000_000_000,
      };
    },
    mutation: (_reference, { name, args }) =>
      new Promise((resolve, reject) => {
        waiting.push(() => {
          ran.push({ name, args });

          if (name === "devices.reconcile" && state.failures > 0) {
            state.failures -= 1;
            reject(new Error("The server failed"));

            return;
          }

          if (name === "devices.reconcile") resolve({ adopted: state.adopt });
          else if (name === "queue.add") resolve({ ok: true, itemIds: [] });
          else resolve({ ok: true });
        });

        flush();
      }),
  };

  const connection: ConnectionSignal = {
    connected: () => state.connected,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  const client: MusicClient = makeMusicClient(transport);

  return {
    client,
    connection,
    /** Every command the server ran, in order. */
    ran,
    /** The names of the commands the server ran, in order. */
    names: (): ReadonlyArray<string> => ran.map(({ name }) => name),
    /** What `devices.reconcile` answers, and how many calls fail first. */
    state,
    setConnected: (connected: boolean): void => {
      state.connected = connected;

      for (const listener of listeners) listener();
      flush();
    },
    /** Takes commands but neither runs nor answers them until `release`. */
    hold: (): void => {
      state.held = true;
    },
    release: (): void => {
      state.held = false;
      flush();
    },
  };
};

const decodeLocal = Schema.decodeUnknownSync(LocalSessionState);

const decodeServer = Schema.decodeUnknownSync(PlaybackState);

/** A session store that keeps rows as JSON and parses them back, like a database would. */
export const memorySessionStore = (stored: StoredSessions = { local: null, server: null }) => {
  const rows = {
    local: stored.local === null ? null : JSON.stringify(stored.local),
    server: stored.server === null ? null : JSON.stringify(stored.server),
  };

  const store: SessionStore = {
    load: async () => ({
      local: rows.local === null ? null : decodeLocal(JSON.parse(rows.local)),
      server: rows.server === null ? null : decodeServer(JSON.parse(rows.server)),
    }),
    saveLocal: async (state) => {
      rows.local = state === null ? null : JSON.stringify(state);
    },
    saveServer: async (state) => {
      rows.server = JSON.stringify(state);
    },
  };

  return {
    store,
    /** The session saved for this device, parsed, or null. */
    local: (): LocalSessionState | null =>
      rows.local === null ? null : decodeLocal(JSON.parse(rows.local)),
  };
};

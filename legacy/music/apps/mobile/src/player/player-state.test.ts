import { AlbumId, ArtistId, DeviceId, QueueItemId, TrackId } from "@music/commands/ids";
import type { PlaybackState, QueueEntry } from "@music/commands/models";
import type { ControllerSnapshot } from "@music/player/playback-controller";
import { chooseStreamProfile } from "@music/player/stream-quality";
import { assert, integer, nat, property, string, uniqueArray } from "fast-check";
import { describe, expect, it } from "vitest";

import { ServerOrigin } from "../lib/server";

import {
  moveArgs,
  nextRepeat,
  nowPlayingOf,
  parseQuality,
  playsOnIos,
  queueItemOf,
  roleOf,
  statusOf,
} from "./player-state";

const phone = DeviceId.make("phone");

const laptop = DeviceId.make("laptop");

const entry = (id: string, withheld = false): QueueEntry => {
  const song = {
    itemId: QueueItemId.make(`item-${id}`),
    addedBy: null,
    autoplay: false,
    id: TrackId.make(id),
    title: `Song ${id}`,
    artist: "Artist",
    artistId: ArtistId.make("artist"),
    album: "Album",
    albumId: AlbumId.make("album"),
    trackNumber: null,
    discNumber: null,
    durationMs: 200_000,
    codec: "FLAC",
    lossless: true,
    bitrate: null,
    sampleRate: 44_100,
    bitDepth: 16,
    artUrl: "/media/art/abc?exp=1&sig=s",
    liked: false,
  };

  return withheld ? { ...song, withheld: true } : song;
};

const session = (
  activeId: DeviceId | null,
  playing: boolean,
  queue: ReadonlyArray<QueueEntry> = [entry("a"), entry("b")],
): PlaybackState => ({
  activeDevice:
    activeId === null
      ? null
      : { id: activeId, name: activeId, kind: "web", lastSeenAt: 0, online: true },
  queue,
  index: 0,
  positionMs: 0,
  playing,
  updatedAt: 0,
  shuffle: false,
  repeat: "off",
  autoplay: true,
  volume: 1,
  following: false,
});

const local = (patch: Partial<ControllerSnapshot> = {}): ControllerSnapshot => ({
  engineStatus: "idle",
  error: null,
  mediaOnline: true,
  quality: "high",
  autoplayBlocked: false,
  pendingPlaying: null,
  pendingVolume: null,
  engine: "html",
  ...patch,
});

/** The server's `queue.move`: the entry goes right after `afterItemId`, or first without one. */
const serverMove = (
  ids: ReadonlyArray<string>,
  itemId: string,
  afterItemId: string | undefined,
): ReadonlyArray<string> => {
  const rest = ids.filter((id) => id !== itemId);
  const after = afterItemId === undefined ? -1 : rest.indexOf(afterItemId);

  return [...rest.slice(0, after + 1), itemId, ...rest.slice(after + 1)];
};

describe("player state", () => {
  it("plays here when the session names this phone, and says where otherwise", () => {
    const remote = session(laptop, true);

    expect(roleOf(session(phone, true).activeDevice, phone)).toStrictEqual({ kind: "local" });
    expect(roleOf(remote.activeDevice, phone)).toStrictEqual({
      kind: "remote",
      device: { id: laptop, name: "laptop", kind: "web" },
    });
    expect(roleOf(null, phone)).toStrictEqual({ kind: "none" });
  });

  it("shows this phone's audio when it plays here and the session's when it plays elsewhere", () => {
    const here = session(phone, true);
    const there = session(laptop, true);

    expect(statusOf(here, local({ engineStatus: "buffering" }), { kind: "local" })).toBe(
      "buffering",
    );
    expect(statusOf(here, local({ engineStatus: "error" }), { kind: "local" })).toBe("failed");
    expect(statusOf(here, local(), { kind: "local" })).toBe("loading");
    expect(statusOf(there, local(), roleOf(there.activeDevice, phone))).toBe("playing");
    expect(
      statusOf(there, local({ pendingPlaying: false }), roleOf(there.activeDevice, phone)),
    ).toBe("paused");
    expect(statusOf(session(null, false, []), local(), { kind: "none" })).toBe("idle");
    expect(statusOf(undefined, local(), { kind: "none" })).toBe("loading");
  });

  it("resolves art against the server and hides links for a song a Jam keeps private", () => {
    const song = entry("a");
    const origin = ServerOrigin.make("https://music.example");

    expect(nowPlayingOf(song, origin).artUrl).toBe(
      "https://music.example/media/art/abc?exp=1&sig=s",
    );
    expect(nowPlayingOf(song, origin)).toMatchObject({ albumId: "album" });
    expect(nowPlayingOf(entry("a", true), origin)).not.toHaveProperty("albumId");
  });

  it("shows a downloaded song's cover from its file", () => {
    const origin = ServerOrigin.make("https://music.example");

    expect(nowPlayingOf(entry("a"), origin, "file:///art/abc").artUrl).toBe("file:///art/abc");
    expect(queueItemOf(entry("a"), origin, "file:///art/abc").artUrl).toBe("file:///art/abc");
  });

  it("cycles repeat off, all, one, and back", () => {
    expect([nextRepeat("off"), nextRepeat("all"), nextRepeat("one")]).toStrictEqual([
      "all",
      "one",
      "off",
    ]);
  });

  it("moves a queue entry to the index asked for, as the server places it", () => {
    assert(
      property(
        uniqueArray(string({ minLength: 1 }), { minLength: 1, maxLength: 12 }),
        nat(),
        integer({ min: -3, max: 15 }),
        (ids, pick, toIndex) => {
          const queue = ids.map((id) => ({ itemId: QueueItemId.make(id) }));
          const itemId = QueueItemId.make(ids[pick % ids.length] ?? "");
          const args = moveArgs(queue, itemId, toIndex);

          expect(args).not.toBeNull();
          const moved = serverMove(ids, itemId, args?.afterItemId);

          expect(moved.indexOf(itemId)).toBe(Math.min(Math.max(0, toIndex), ids.length - 1));
        },
      ),
    );
  });

  it("does not move an entry that left the queue", () => {
    expect(moveArgs([{ itemId: QueueItemId.make("a") }], QueueItemId.make("b"), 0)).toBeNull();
  });

  it("streams originals iOS decodes at lossless quality and transcodes the rest", () => {
    expect(chooseStreamProfile("lossless", "FLAC", playsOnIos)).toBe("original");
    expect(chooseStreamProfile("lossless", "ALAC", playsOnIos)).toBe("original");
    expect(chooseStreamProfile("lossless", "MPEG 1 Layer 3", playsOnIos)).toBe("original");
    expect(chooseStreamProfile("lossless", "Vorbis I", playsOnIos)).toBe("aac-320");
    expect(chooseStreamProfile("lossless", "Opus", playsOnIos)).toBe("aac-320");
    expect(chooseStreamProfile(parseQuality(null), "FLAC", playsOnIos)).toBe("aac-320");
  });
});

import { createServer } from "node:http";

import {
  AlbumId,
  ArtistId,
  ControllerId,
  DeviceId,
  QueueItemId,
  TrackId,
} from "@music/commands/ids";
import { StreamProfile } from "@music/commands/models";
import type { PlaybackState, QueueEntry } from "@music/commands/models";
import { makeMusicClient } from "@music/sdk/client";
import type { CommandTransport } from "@music/sdk/client";
import { ConvexError } from "convex/values";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { EngineEvent, EngineKind, PlayerEngine } from "./engine";
import { PlaybackController } from "./playback-controller";
import type { ControllerEnvironment } from "./playback-controller";
import { serverSession } from "./session-router";
import { streamSources } from "./source-resolver";
import type { StreamQuality } from "./stream-quality";

const deviceId = DeviceId.make("this-browser");

const controllerId = ControllerId.make("this-controller");

const SIX_HOURS = 6 * 60 * 60 * 1000;

const entry = (id: string, itemId: string): QueueEntry => ({
  itemId: QueueItemId.make(itemId),
  addedBy: null,
  autoplay: false,
  id: TrackId.make(id),
  title: "Song",
  artist: "Artist",
  artistId: ArtistId.make("artist"),
  album: "Album",
  albumId: AlbumId.make("album"),
  trackNumber: null,
  discNumber: null,
  durationMs: 200_000,
  codec: "AAC",
  lossless: false,
  bitrate: null,
  sampleRate: null,
  bitDepth: null,
  artUrl: null,
  liked: false,
});

const song = entry("song", "1");

type SessionFields = Partial<
  Pick<PlaybackState, "activeDevice" | "queue" | "index" | "positionMs" | "control">
>;

const session = (
  playing: boolean,
  updatedAt: number,
  following = false,
  fields: SessionFields = {},
): PlaybackState => ({
  activeDevice: { id: deviceId, name: "Test", kind: "web", lastSeenAt: 0, online: true },
  queue: [song],
  index: 0,
  positionMs: 0,
  playing,
  updatedAt,
  shuffle: false,
  repeat: "off",
  autoplay: false,
  volume: 1,
  following,
  ...fields,
});

interface Mutation {
  readonly name: string;
  readonly args: unknown;
}

interface Load {
  readonly kind: EngineKind;
  readonly url: string;
  readonly startMs: number;
}

interface EngineRecord {
  readonly created: Array<EngineKind>;
  readonly loads: Array<Load>;
  plays: number;
  readonly seeks: Array<number>;
}

const instantEngine = (
  kind: EngineKind,
  record: EngineRecord,
  ready: () => Promise<void> = async () => {},
): PlayerEngine & {
  readonly emit: (event: EngineEvent) => void;
  readonly notify: (event: EngineEvent) => void;
} => {
  const listeners = new Set<(event: EngineEvent) => void>();
  let generation = 0;
  let paused = true;
  let positionMs = 0;
  const notify = (event: EngineEvent): void => listeners.forEach((listener) => listener(event));

  const emit = (event: EngineEvent): void => {
    if (event.type === "time") positionMs = event.positionMs;

    if (event.type === "playing") paused = false;
    else if (event.type === "paused") paused = true;
    notify(event);
  };

  record.created.push(kind);

  return {
    emit,
    notify,
    samplePlayback: () => ({ positionMs, playing: !paused }),
    load: async (source, startMs, autoplay) => {
      const loading = ++generation;
      record.loads.push({ kind, url: source.url, startMs });
      await ready();

      if (loading !== generation) return;
      positionMs = startMs;
      emit({ type: autoplay ? "playing" : "paused" });
    },
    preload: () => {},
    play: async () => {
      record.plays += 1;
      emit({ type: "playing" });
    },
    pause: () => emit({ type: "paused" }),
    seek: (target) => {
      record.seeks.push(target);
      emit({ type: "time", positionMs: target });
    },
    setVolume: () => {},
    unload: () => {
      generation += 1;
      paused = true;
      positionMs = 0;
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
};

const ListeningAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }));

const decodeStreamArgs = Schema.decodeUnknownSync(
  Schema.Struct({ profile: StreamProfile, requestedAt: Schema.optionalKey(Schema.Finite) }),
);

const decodeProfile = Schema.decodeUnknownSync(StreamProfile);

const fakeMediaService = async () => {
  const state = { streamStatus: 200 };

  const server = createServer((request, response) => {
    response.writeHead(request.url === "/media/health" ? 200 : state.streamStatus).end("ok");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = ListeningAddress(server.address());

  return {
    base: `http://127.0.0.1:${port}/media`,
    state,
    close: () => {
      server.close();
    },
  };
};

const recordingTransport = (
  mutations: Array<Mutation>,
  base: string,
  now: () => number,
  ttlMs = SIX_HOURS,
): CommandTransport => {
  const cached = new Map<string, { url: string; profile: StreamProfile; expiresAt: number }>();

  return {
    query: async (_reference, { args }) => {
      const { profile, requestedAt } = decodeStreamArgs(args);
      const key = `${profile}:${requestedAt ?? "none"}`;

      const signed = cached.get(key) ?? {
        url: `${base}/stream/song?p=${profile}&n=${cached.size + 1}`,
        profile,
        expiresAt: now() + ttlMs,
      };

      cached.set(key, signed);

      return { trackId: song.id, ...signed };
    },
    mutation: async (_reference, { name, args }) => {
      mutations.push({ name, args });

      return { ok: true };
    },
  };
};

const reports = (mutations: ReadonlyArray<Mutation>): ReadonlyArray<unknown> =>
  mutations.flatMap(({ name, args }) => (name === "playback.report" ? [args] : []));

const profileOf = (url: string | undefined): StreamProfile | null =>
  url === undefined ? null : decodeProfile(new URL(url).searchParams.get("p"));

const testHost = (
  resolveUrl: (url: string) => string = (url) => url,
): Pick<ControllerEnvironment, "nowPlaying" | "onForeground"> & {
  readonly resolveUrl: (url: string) => string;
  readonly foreground: () => void;
} => {
  const listeners = new Set<() => void>();

  return {
    nowPlaying: { setHandlers: () => {}, show: () => {} },
    onForeground: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    resolveUrl,
    foreground: () => listeners.forEach((listener) => listener()),
  };
};

const setup = async (options: {
  readonly gapless: boolean;
  readonly loadReady?: () => Promise<void>;
  readonly quality?: StreamQuality;
  readonly serverAheadMs?: number;
  readonly ttlMs?: number;
  readonly resolveUrl?: (url: string) => string;
}) => {
  const media = await fakeMediaService();
  const mutations: Array<Mutation> = [];
  const clock = { now: 1_000_000, monotonic: 0 };
  const record: EngineRecord = { created: [], loads: [], plays: 0, seeks: [] };
  const engines: Array<ReturnType<typeof instantEngine>> = [];
  const host = testHost(options.resolveUrl);

  const client = makeMusicClient(
    recordingTransport(
      mutations,
      media.base,
      () => clock.now + (options.serverAheadMs ?? 0),
      options.ttlMs,
    ),
  );

  const controller = new PlaybackController(
    serverSession(client),
    streamSources(client, { now: () => clock.now, resolveUrl: host.resolveUrl }),
    {
      mse: options.gapless ? { flac: true, changeType: true } : null,
      create: (kind) => {
        const engine = instantEngine(kind, record, options.loadReady);

        engines.push(engine);

        return engine;
      },
    },
    {
      deviceId,
      controllerId,
      device: { name: "Test", kind: "web" },
      canPlay: () => true,
      now: () => clock.now,
      monotonicNow: () => clock.monotonic,
      quality: options.quality ?? "high",
      saveQuality: () => {},
      ...host,
    },
  );

  const stop = controller.start();

  return {
    controller,
    media,
    mutations,
    clock,
    record,
    foreground: host.foreground,
    engine: () => {
      const engine = engines.at(-1);

      if (engine === undefined) throw new Error("The controller created no engine");

      return engine;
    },
    stop: () => {
      stop();
      media.close();
    },
  };
};

describe("PlaybackController", () => {
  it("samples current output when an older playing callback arrives after pause", async () => {
    const { controller, mutations, engine, stop } = await setup({ gapless: false });

    try {
      controller.sync(session(true, 1));
      await vi.waitFor(() => expect(reports(mutations)).toHaveLength(1));
      controller.sync(session(false, 2));
      engine().notify({ type: "playing" });

      expect(reports(mutations).at(-1)).toMatchObject({ playing: false });
      expect(controller.getSnapshot().engineStatus).toBe("paused");
    } finally {
      stop();
    }
  });

  it("samples current output when an older paused callback arrives after resume", async () => {
    const { controller, mutations, engine, stop } = await setup({ gapless: false });

    try {
      controller.sync(session(true, 1));
      await vi.waitFor(() => expect(reports(mutations)).toHaveLength(1));
      controller.sync(session(false, 2));
      controller.sync(session(true, 3));
      engine().notify({ type: "paused" });

      expect(reports(mutations).at(-1)).toMatchObject({ playing: true });
      expect(controller.getSnapshot().engineStatus).toBe("playing");
    } finally {
      stop();
    }
  });

  it("keeps a sent measurement stamped with the control it followed", async () => {
    const { controller, mutations, engine, stop } = await setup({ gapless: false });

    try {
      controller.sync(session(true, 1, false, { control: { revision: 1, seek: 1, transport: 1 } }));
      await vi.waitFor(() => expect(reports(mutations)).toHaveLength(1));
      const held = reports(mutations)[0];
      controller.sync(
        session(false, 2, false, { control: { revision: 2, seek: 1, transport: 2 } }),
      );
      engine().notify({ type: "playing" });

      expect(held).toMatchObject({ playing: true, controlRevision: 1 });
      expect(reports(mutations).at(-1)).toMatchObject({ playing: false, controlRevision: 2 });
    } finally {
      stop();
    }
  });

  it("catches up a genuine output stop after a concurrent seek without resuming it", async () => {
    const { controller, mutations, engine, record, clock, stop } = await setup({ gapless: false });

    try {
      controller.sync(
        session(true, clock.now, false, { control: { revision: 1, seek: 1, transport: 1 } }),
      );
      await vi.waitFor(() => expect(reports(mutations)).toHaveLength(1));
      engine().emit({ type: "paused" });
      controller.sync(
        session(true, clock.now, false, {
          positionMs: 3000,
          control: { revision: 2, seek: 2, transport: 1 },
        }),
      );

      expect(record.plays).toBe(0);
      expect(reports(mutations).at(-1)).toMatchObject({
        playing: false,
        positionMs: 3000,
        controlRevision: 2,
      });
      const count = reports(mutations).length;
      controller.sync(
        session(true, clock.now, false, {
          positionMs: 3000,
          control: { revision: 2, seek: 2, transport: 1 },
        }),
      );
      expect(reports(mutations)).toHaveLength(count);
    } finally {
      stop();
    }
  });

  it.each([
    { name: "pause", playing: false, positionMs: 0, seek: 1, transport: 2 },
    { name: "seek", playing: true, positionMs: 3000, seek: 2, transport: 1 },
  ])("applies a newer $name while an engine load waits for audio", async (target) => {
    const ready = Promise.withResolvers<void>();

    const { controller, mutations, record, engine, clock, stop } = await setup({
      gapless: false,
      loadReady: () => ready.promise,
    });

    try {
      controller.sync(
        session(true, clock.now, false, { control: { revision: 1, seek: 1, transport: 1 } }),
      );
      await vi.waitFor(() => expect(record.loads).toHaveLength(1));
      expect(reports(mutations)).toEqual([]);
      controller.sync(
        session(target.playing, clock.now, false, {
          positionMs: target.positionMs,
          control: { revision: 2, seek: target.seek, transport: target.transport },
        }),
      );
      await vi.waitFor(() => expect(record.loads).toHaveLength(target.name === "pause" ? 1 : 2));
      ready.resolve();
      await vi.waitFor(() => expect(reports(mutations)).toHaveLength(1));

      expect(engine().samplePlayback().playing).toBe(target.playing);
      expect(reports(mutations)[0]).toMatchObject({
        controlRevision: 2,
        playing: target.playing,
        positionMs: target.positionMs,
      });
    } finally {
      ready.resolve();
      stop();
    }
  });

  it("keeps a local seek target through loading and its own echo", async () => {
    const ready = Promise.withResolvers<void>();

    const { controller, record, mutations, clock, stop } = await setup({
      gapless: false,
      loadReady: () => ready.promise,
    });

    try {
      controller.sync(
        session(true, clock.now, false, { control: { revision: 1, seek: 1, transport: 1 } }),
      );
      await vi.waitFor(() => expect(record.loads).toHaveLength(1));
      await controller.seek(3000);
      expect(mutations).toContainEqual({
        name: "playback.seek",
        args: { positionMs: 3000, appliedBy: controllerId },
      });
      await vi.waitFor(() => expect(record.loads).toHaveLength(2));
      controller.sync(
        session(true, clock.now, false, {
          positionMs: 3000,
          control: { revision: 2, seek: 2, transport: 1, appliedBy: controllerId },
        }),
      );
      ready.resolve();
      await vi.waitFor(() => expect(reports(mutations)).toHaveLength(1));
      expect(record.loads).toHaveLength(2);
      expect(reports(mutations)[0]).toMatchObject({
        positionMs: 3000,
        playing: true,
        controlRevision: 2,
      });
    } finally {
      ready.resolve();
      stop();
    }
  });

  it("applies another controller's seek when both controllers share a device ID", async () => {
    const { controller, mutations, record, clock, stop } = await setup({ gapless: false });

    try {
      controller.sync(
        session(false, clock.now, false, { control: { revision: 1, seek: 1, transport: 1 } }),
      );
      await vi.waitFor(() => expect(reports(mutations)).toHaveLength(1));
      controller.sync(
        session(false, clock.now, false, {
          positionMs: 60_000,
          control: {
            revision: 2,
            seek: 2,
            transport: 1,
            appliedBy: ControllerId.make("this-browser"),
          },
        }),
      );

      expect(record.seeks).toEqual([60_000]);
      expect(controller.positionMs()).toBe(60_000);
    } finally {
      stop();
    }
  });

  it("keeps local seek echoes from seeking twice or undoing newer optimistic seeks", async () => {
    const { controller, mutations, record, clock, stop } = await setup({ gapless: false });

    try {
      controller.sync(
        session(false, clock.now, false, { control: { revision: 1, seek: 1, transport: 1 } }),
      );
      await vi.waitFor(() => expect(reports(mutations)).toHaveLength(1));
      await controller.seek(5000);
      await controller.seek(5500);
      controller.sync(
        session(false, clock.now, false, {
          positionMs: 5000,
          control: { revision: 2, seek: 2, transport: 1, appliedBy: controllerId },
        }),
      );
      controller.sync(
        session(false, clock.now, false, {
          positionMs: 5500,
          control: { revision: 3, seek: 3, transport: 1, appliedBy: controllerId },
        }),
      );
      expect(record.seeks).toEqual([5000, 5500]);
      controller.sync(
        session(false, clock.now, false, {
          positionMs: 5000,
          control: { revision: 4, seek: 4, transport: 1 },
        }),
      );
      expect(record.seeks).toEqual([5000, 5500, 5000]);
    } finally {
      stop();
    }
  });

  it("does not publish a paused measurement when a load fails", async () => {
    const { controller, engine, mutations, clock, stop } = await setup({ gapless: false });

    try {
      engine().load = async () =>
        engine().notify({ type: "error", reason: "network", message: "offline" });
      controller.sync(
        session(true, clock.now, false, { control: { revision: 1, seek: 1, transport: 1 } }),
      );
      await vi.waitFor(() => expect(controller.getSnapshot().engineStatus).toBe("error"));
      expect(reports(mutations)).toEqual([]);
    } finally {
      stop();
    }
  });

  it("keeps an error visible when output pauses", async () => {
    const { controller, engine, mutations, stop } = await setup({ gapless: false });

    try {
      controller.sync(session(true, 1));
      await vi.waitFor(() => expect(reports(mutations)).toHaveLength(1));
      await controller.attempt(Promise.reject(new Error("refused transfer")));
      const error = controller.getSnapshot().error;
      engine().emit({ type: "paused" });
      expect(controller.getSnapshot().error).toBe(error);
    } finally {
      stop();
    }
  });

  it("plays a stream from the URL the host resolves the signed one to", async () => {
    const { controller, media, record, stop } = await setup({
      gapless: false,
      resolveUrl: (url) => url.replace("/stream/", "/resolved/stream/"),
    });

    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));

    expect(record.loads[0]?.url.startsWith(`${media.base}/resolved/stream/song?`)).toBe(true);
    stop();
  });

  it("tells the server this device is online when the app returns to the foreground", async () => {
    const { mutations, foreground, stop } = await setup({ gapless: false });
    await vi.waitFor(() => expect(mutations).toHaveLength(1));

    foreground();
    await vi.waitFor(() => expect(mutations).toHaveLength(2));

    expect(mutations.map(({ name }) => name)).toStrictEqual([
      "devices.heartbeat",
      "devices.heartbeat",
    ]);
    stop();
  });

  it("tells attempt's caller whether a server call landed, and shows a failure as the error", async () => {
    const { controller, stop } = await setup({ gapless: false });

    await expect(controller.attempt(Promise.resolve({ ok: true }))).resolves.toBe(true);
    expect(controller.getSnapshot().error).toBeNull();

    await expect(
      controller.attempt(Promise.reject(new Error("queue.remove failed"))),
    ).resolves.toBe(false);
    expect(controller.getSnapshot().error).not.toBeNull();
    stop();
  });

  it("does not report a pause that a session snapshot ordered", async () => {
    const { controller, mutations, stop } = await setup({ gapless: false });
    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(controller.getSnapshot().engineStatus).toBe("playing"));
    const before = reports(mutations).length;

    controller.sync(session(false, 2));

    expect(controller.getSnapshot().engineStatus).toBe("paused");
    await Promise.resolve();
    expect(reports(mutations).slice(before)).toStrictEqual([]);
    stop();
  });

  it("listening along, plays the host's song but never reports or moves the queue on", async () => {
    const { controller, engine, mutations, stop } = await setup({ gapless: false });
    const following = session(true, 1, true);

    controller.sync(following);
    await vi.waitFor(() => expect(controller.getSnapshot().engineStatus).toBe("playing"));

    engine().emit({ type: "ended" });
    engine().emit({ type: "paused" });
    await Promise.resolve();

    const moved = mutations.filter(
      ({ name }) => name === "playback.next" || name === "playback.report",
    );

    expect(moved).toStrictEqual([]);
    stop();
  });

  it("listening along, starts at the live position when the host reported a while ago", async () => {
    const { controller, clock, record, stop } = await setup({ gapless: false });

    controller.sync(session(true, clock.now - 14_000, true));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));

    expect(record.loads[0]?.startMs).toBeGreaterThanOrEqual(14_000);
    stop();
  });

  it("listening along, plays on when the host refuses a pause", async () => {
    const media = await fakeMediaService();
    const mutations: Array<Mutation> = [];
    const recording = recordingTransport(mutations, media.base, () => 1000);
    const record: EngineRecord = { created: [], loads: [], plays: 0, seeks: [] };

    const client = makeMusicClient({
      query: (reference, args) => recording.query(reference, args),
      mutation: async (reference, args) => {
        if (args.name === "playback.pause") {
          throw new ConvexError({
            code: "forbidden",
            message: "The host controls playback in this Jam",
          });
        }

        return recording.mutation(reference, args);
      },
    });

    const controller = new PlaybackController(
      serverSession(client),
      streamSources(client, { now: () => 1000, resolveUrl: (url) => url }),
      { mse: null, create: (kind) => instantEngine(kind, record) },
      {
        deviceId,
        controllerId,
        device: { name: "Test", kind: "web" },
        canPlay: () => true,
        now: () => 1000,
        monotonicNow: () => 1000,
        quality: "high",
        saveQuality: () => {},
        ...testHost(),
      },
    );

    const stop = controller.start();

    controller.sync(session(true, 1, true));
    await vi.waitFor(() => expect(controller.getSnapshot().engineStatus).toBe("playing"));
    const plays = record.plays;

    await controller.togglePlay();

    expect(controller.getSnapshot().engineStatus).toBe("playing");
    expect(record.plays).toBe(plays + 1);
    stop();
    media.close();
  });

  it("reports a pause the browser causes before the server confirms a Play", async () => {
    const { controller, engine, mutations, stop } = await setup({ gapless: false });
    controller.sync(session(false, 1));
    await vi.waitFor(() => expect(controller.getSnapshot().engineStatus).toBe("paused"));
    await controller.togglePlay();
    expect(controller.getSnapshot().engineStatus).toBe("playing");

    engine().emit({ type: "paused" });

    await vi.waitFor(() => expect(reports(mutations).at(-1)).toMatchObject({ playing: false }));
    stop();
  });

  it("registers again before playing when the first heartbeat failed", async () => {
    const media = await fakeMediaService();
    const mutations: Array<Mutation> = [];
    const recording = recordingTransport(mutations, media.base, () => 1000);
    const record: EngineRecord = { created: [], loads: [], plays: 0, seeks: [] };
    let heartbeats = 0;

    const flaky: CommandTransport = {
      query: async (reference, args) => recording.query(reference, args),
      mutation: async (reference, args) => {
        if (args.name === "devices.heartbeat") {
          heartbeats += 1;

          if (heartbeats === 1) throw new Error("The network dropped");
        }

        return recording.mutation(reference, args);
      },
    };

    const client = makeMusicClient(flaky);

    const controller = new PlaybackController(
      serverSession(client),
      streamSources(client, { now: () => 1000, resolveUrl: (url) => url }),
      { mse: null, create: (kind) => instantEngine(kind, record) },
      {
        deviceId,
        controllerId,
        device: { name: "Test", kind: "web" },
        canPlay: () => true,
        now: () => 1000,
        monotonicNow: () => 1000,
        quality: "high",
        saveQuality: () => {},
        ...testHost(),
      },
    );

    const stop = controller.start();
    await controller.playTracks([song.id]);

    expect(mutations.map(({ name }) => name)).toStrictEqual(["devices.heartbeat", "playback.play"]);
    stop();
    media.close();
  });

  it("signs a refused gapless stream again and stays on the gapless engine", async () => {
    const { controller, engine, clock, record, stop } = await setup({ gapless: true });
    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));

    clock.now += 60_000;
    engine().emit({ type: "error", reason: "expired", message: "The URL expired" });

    await vi.waitFor(() => expect(record.loads).toHaveLength(2));
    expect(record.loads.map((load) => load.kind)).toEqual(["mse", "mse"]);
    expect(record.loads[1]?.url).not.toBe(record.loads[0]?.url);
    expect(controller.getSnapshot()).toMatchObject({ engine: "mse", error: null });
    stop();
  });

  it("signs a refused original stream again instead of transcoding it", async () => {
    const { controller, engine, media, clock, record, stop } = await setup({
      gapless: false,
      quality: "lossless",
    });

    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));
    expect(profileOf(record.loads[0]?.url)).toBe("original");

    media.state.streamStatus = 403;
    clock.now += 60_000;
    engine().emit({ type: "error", reason: "unsupported", message: "Format error" });

    await vi.waitFor(() => expect(record.loads).toHaveLength(2));
    expect(profileOf(record.loads[1]?.url)).toBe("original");
    stop();
  });

  it("signs a stream again when its URL is past its expiry, without asking", async () => {
    const { controller, engine, clock, record, stop } = await setup({
      gapless: false,
      quality: "lossless",
    });

    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));

    clock.now += SIX_HOURS + 1;
    engine().emit({ type: "error", reason: "unsupported", message: "Format error" });

    await vi.waitFor(() => expect(record.loads).toHaveLength(2));
    expect(profileOf(record.loads[1]?.url)).toBe("original");
    stop();
  });

  it("does not reload on every resume when the device clock is hours ahead of the server's", async () => {
    const { controller, record, stop } = await setup({
      gapless: true,
      serverAheadMs: -7 * 60 * 60 * 1000,
    });

    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));
    await controller.togglePlay();
    await controller.togglePlay();

    expect(record.plays).toBe(1);
    expect(record.loads).toHaveLength(1);
    stop();
  });

  it("does not ask about a transcoded stream, which could start a transcode", async () => {
    const { controller, engine, media, clock, record, stop } = await setup({ gapless: false });
    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));
    expect(profileOf(record.loads[0]?.url)).toBe("aac-320");

    media.state.streamStatus = 403;
    clock.now += 60_000;
    engine().emit({ type: "error", reason: "unsupported", message: "Format error" });

    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        engineStatus: "error",
        error: "Format error",
      }),
    );
    expect(record.loads).toHaveLength(1);
    stop();
  });

  it("moves to HTML audio when the gapless engine cannot play a stream it may fetch", async () => {
    const { controller, engine, record, stop } = await setup({ gapless: true });
    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));

    engine().emit({ type: "error", reason: "unsupported", message: "Unsupported codec" });

    await vi.waitFor(() => expect(record.loads).toHaveLength(2));
    expect(record.loads.map((load) => load.kind)).toEqual(["mse", "html"]);
    expect(profileOf(record.loads[1]?.url)).toBe("aac-320");
    expect(controller.getSnapshot().engine).toBe("html");
    stop();
  });

  it("transcodes an original file the browser cannot play", async () => {
    const { controller, engine, record, stop } = await setup({
      gapless: false,
      quality: "lossless",
    });

    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));

    engine().emit({ type: "error", reason: "decode", message: "Decode error" });

    await vi.waitFor(() => expect(record.loads).toHaveLength(2));
    expect(profileOf(record.loads[1]?.url)).toBe("aac-320");
    stop();
  });

  it("signs the stream again before resuming after a pause longer than its URL lasts", async () => {
    const { controller, clock, record, stop } = await setup({ gapless: true });
    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));
    await controller.togglePlay();
    expect(controller.getSnapshot().engineStatus).toBe("paused");

    clock.now += SIX_HOURS;
    await controller.togglePlay();

    await vi.waitFor(() => expect(record.loads).toHaveLength(2));
    expect(record.plays).toBe(0);
    expect(record.loads[1]?.url).not.toBe(record.loads[0]?.url);
    stop();
  });

  it("signs a short-lived stream (a Jam member's) again halfway through its life", async () => {
    const { controller, clock, record, stop } = await setup({ gapless: true, ttlMs: 5 * 60_000 });
    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));
    await controller.togglePlay();

    clock.now += 2 * 60_000;
    await controller.togglePlay();
    expect(record.loads).toHaveLength(1);
    await controller.togglePlay();

    clock.now += 60_000;
    await controller.togglePlay();
    await vi.waitFor(() => expect(record.loads).toHaveLength(2));
    expect(record.loads[1]?.url).not.toBe(record.loads[0]?.url);
    stop();
  });

  it("reports an error instead of signing again when a fresh URL is refused too", async () => {
    const { controller, engine, record, stop } = await setup({ gapless: true });
    controller.sync(session(false, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));

    engine().emit({ type: "error", reason: "expired", message: "Refused" });
    await vi.waitFor(() => expect(record.loads).toHaveLength(2));
    engine().emit({ type: "error", reason: "expired", message: "Refused" });

    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        engineStatus: "error",
        error: "The media server refused this song's stream",
      }),
    );
    expect(record.loads).toHaveLength(2);
    stop();
  });

  it("loads the song again from the session on retry after it failed", async () => {
    const { controller, engine, record, stop } = await setup({ gapless: true });
    controller.sync(session(false, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));
    engine().emit({ type: "error", reason: "expired", message: "Refused" });
    await vi.waitFor(() => expect(record.loads).toHaveLength(2));
    engine().emit({ type: "error", reason: "expired", message: "Refused" });
    await vi.waitFor(() => expect(controller.getSnapshot().engineStatus).toBe("error"));

    controller.retry();

    expect(controller.getSnapshot().error).toBeNull();
    await vi.waitFor(() => expect(record.loads).toHaveLength(3));
    stop();
  });

  it("does nothing on retry while the song plays", async () => {
    const { controller, record, stop } = await setup({ gapless: true });
    controller.sync(session(true, 1));
    await vi.waitFor(() => expect(record.loads).toHaveLength(1));

    controller.retry();

    expect(record.loads).toHaveLength(1);
    stop();
  });
});

const playingAt = async (atMs: number) => {
  const harness = await setup({ gapless: false });

  harness.controller.sync(session(true, harness.clock.now));
  await vi.waitFor(() => expect(harness.controller.getSnapshot().engineStatus).toBe("playing"));
  harness.engine().emit({ type: "time", positionMs: atMs });

  return harness;
};

describe("PlaybackController.positionMs", () => {
  it("moves on between the engine's reports while playing", async () => {
    const { controller, clock, stop } = await playingAt(10_000);

    clock.monotonic += 150;
    expect(controller.positionMs()).toBe(10_150);
    clock.monotonic += 40;
    expect(controller.positionMs()).toBe(10_190);
    stop();
  });

  it("starts again from each new report, even one behind the extrapolation", async () => {
    const { controller, clock, engine, stop } = await playingAt(10_000);

    clock.monotonic += 190;
    engine().emit({ type: "time", positionMs: 10_180 });
    expect(controller.positionMs()).toBe(10_180);
    clock.monotonic += 20;
    expect(controller.positionMs()).toBe(10_200);
    stop();
  });

  it("holds while buffering or paused and moves on again once playing", async () => {
    const { controller, clock, engine, stop } = await playingAt(10_000);

    clock.monotonic += 100;
    engine().emit({ type: "waiting" });
    clock.monotonic += 500;
    expect(controller.positionMs()).toBe(10_100);

    engine().emit({ type: "playing" });
    clock.monotonic += 50;
    expect(controller.positionMs()).toBe(10_150);

    engine().emit({ type: "paused" });
    clock.monotonic += 5000;
    expect(controller.positionMs()).toBe(10_150);
    stop();
  });

  it("moves on from a seek's target at once", async () => {
    const { controller, clock, stop } = await playingAt(10_000);

    clock.monotonic += 120;
    void controller.seek(42_000);
    expect(controller.positionMs()).toBe(42_000);
    clock.monotonic += 100;
    expect(controller.positionMs()).toBe(42_100);
    stop();
  });

  it("starts a new song from its start", async () => {
    const { controller, clock, record, stop } = await playingAt(10_000);
    clock.monotonic += 3000;
    controller.sync(
      session(true, clock.now, false, { queue: [song, entry("next", "2")], index: 1 }),
    );
    await vi.waitFor(() => expect(record.loads).toHaveLength(2));
    expect(controller.positionMs()).toBe(0);
    clock.monotonic += 80;
    expect(controller.positionMs()).toBe(80);
    stop();
  });

  it("follows the monotonic clock, not the wall clock, and stops at the end of the song", async () => {
    const { controller, clock, stop } = await playingAt(song.durationMs - 100);

    clock.now += 60_000;
    expect(controller.positionMs()).toBe(song.durationMs - 100);
    clock.monotonic += 500;
    expect(controller.positionMs()).toBe(song.durationMs);
    stop();
  });

  it("reports a pause at the moved-on position, not the engine's last report", async () => {
    const { controller, clock, mutations, stop } = await playingAt(10_000);

    clock.monotonic += 150;
    await controller.togglePlay();

    expect(reports(mutations).at(-1)).toMatchObject({ positionMs: 10_150, playing: false });
    stop();
  });

  it("signs an expired stream again and loads it from the moved-on position", async () => {
    const { clock, engine, record, stop } = await playingAt(10_000);

    clock.monotonic += 150;
    engine().emit({ type: "error", reason: "expired", message: "Expired" });
    clock.monotonic += 5000;
    await vi.waitFor(() => expect(record.loads).toHaveLength(2));

    expect(record.loads[1]?.startMs).toBe(10_150);
    stop();
  });

  it("on another device, runs on from the session's last report", async () => {
    const { controller, clock, stop } = await setup({ gapless: false });
    controller.sync(
      session(true, clock.now - 5000, false, {
        activeDevice: {
          id: DeviceId.make("phone"),
          name: "Phone",
          kind: "phone",
          lastSeenAt: 0,
          online: true,
        },
        positionMs: 30_000,
      }),
    );
    expect(controller.positionMs()).toBe(35_000);
    stop();
  });
});

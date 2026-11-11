import { Conflict } from "@media/contracts/errors";
import type { ClientCapabilities } from "@media/contracts/media-playback";
import { Brand, Predicate, Result } from "effect";
import { describe, expect, it } from "vitest";

import type { CoreStart, PlayCommands, StartArgs } from "./play-session";
import { startArgs, startPlay, startedPlay } from "./play-session";
import { PlaybackStep, PlaybackStop, afterSessionFailure } from "./policy";

const titleId = Brand.nominal<CoreStart["titleId"]>()("title1");

const fileId = Brand.nominal<CoreStart["file"]["id"]>()("file1");

const episodeId = Brand.nominal<NonNullable<CoreStart["episodeId"]>>()("episode1");

const MEDIA = "http://media.lan:4300";

const coreStart = (overrides: Partial<CoreStart> = {}): CoreStart => ({
  titleId,
  episodeId: null,
  episode: null,
  file: {
    id: fileId,
    titleId,
    episodeId: null,
    versionName: null,
    sizeBytes: 1_000,
    probe: {
      container: "mp4",
      durationMs: 1_500_000,
      bitRate: null,
      video: [],
      audio: [],
      subtitles: [],
    },
    externalSubtitles: [],
    hdr: false,
    trickplay: null,
  },
  resumePositionMs: 600_000,
  playbackId: "4d1c2a52-0b5e-4f7e-9d6c-8b2f1e3a7c90",
  startedAt: 1_762_000_000_000,
  ticket: "t1.ticket-one",
  expiresAt: 1_762_021_600_000,
  ...overrides,
});

const capabilities: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [
    { codec: "h264", profiles: ["High"], maxLevel: undefined },
    { codec: "hevc", maxBitDepth: 10 },
  ],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }, { codec: "opus" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
};

/** A platform whose `movies.play.start` answers from `answers` in turn, recording what it was sent. */
const recordingStarts = (answers: ReadonlyArray<() => Promise<CoreStart>>) => {
  const sent: Array<StartArgs> = [];

  const commands: Pick<PlayCommands, "start"> = {
    start: (args) => {
      sent.push(args);

      const answer = answers[sent.length - 1];

      return answer === undefined ? Promise.reject(new Error("no more starts")) : answer();
    },
  };

  return { commands, sent };
};

describe("startedPlay", () => {
  it("puts the ticket where the media server reads a token, and the playback as the session", () => {
    const start = coreStart();
    const played = Result.getOrThrow(startedPlay(start, MEDIA));

    expect(played.start).toBe(start);
    expect(played.started).toMatchObject({
      sessionId: start.playbackId,
      token: "t1.ticket-one",
      tokenExpiresAt: start.expiresAt,
      mediaBaseUrl: MEDIA,
      resumePositionMs: 600_000,
      titleId: "title1",
      episodeId: null,
      file: { id: "file1", missing: false, trickplay: null },
    });
  });

  it("fails with a protocol error for a start the media contracts do not describe", () => {
    const failed = startedPlay(coreStart({ resumePositionMs: -5 }), MEDIA);

    expect(Result.isFailure(failed) && Predicate.isTagged(failed.failure, "ProtocolError")).toBe(
      true,
    );
  });
});

describe("startArgs", () => {
  it("starts the episode in the chosen version with what the device plays", () => {
    expect(startArgs({ titleId, episodeId }, fileId, capabilities)).toStrictEqual({
      titleId,
      episodeId,
      fileId,
      capabilities: {
        containers: ["mp4"],
        videoCodecs: [
          { codec: "h264", profiles: ["High"] },
          { codec: "hevc", maxBitDepth: 10 },
        ],
        audioCodecs: [{ codec: "aac", maxChannels: 2 }, { codec: "opus" }],
        maxWidth: 1920,
        maxHeight: 1080,
        hls: false,
        mse: true,
      },
    });
  });

  it("leaves the episode and the version to the server when there are none", () => {
    const args = startArgs({ titleId, episodeId: null }, null, capabilities);

    expect(Object.keys(args)).toEqual(["titleId", "capabilities"]);
  });
});

describe("startPlay", () => {
  it("takes a new ticket for each start", async () => {
    const { commands, sent } = recordingStarts([
      () => Promise.resolve(coreStart()),
      () => Promise.resolve(coreStart({ ticket: "t1.ticket-two", playbackId: "second" })),
    ]);

    const args = startArgs({ titleId, episodeId: null }, fileId, capabilities);
    const first = Result.getOrThrow(await startPlay(commands, args, MEDIA));
    const again = Result.getOrThrow(await startPlay(commands, args, MEDIA));

    expect(sent).toEqual([args, args]);
    expect([first.started.token, again.started.token]).toEqual(["t1.ticket-one", "t1.ticket-two"]);
    expect([first.started.sessionId, again.started.sessionId]).toEqual([
      "4d1c2a52-0b5e-4f7e-9d6c-8b2f1e3a7c90",
      "second",
    ]);
  });

  it("returns the core's refusal as a value the player turns into a step", async () => {
    const { commands } = recordingStarts([
      () => Promise.reject(new Conflict({ message: "This title's files are missing from disk" })),
    ]);

    const started = await startPlay(
      commands,
      startArgs({ titleId, episodeId: null }, null, capabilities),
      MEDIA,
    );

    if (Result.isSuccess(started)) throw new Error("the start should have failed");
    expect(afterSessionFailure(started.failure)).toStrictEqual(
      PlaybackStep.Stop({ stop: PlaybackStop.Missing() }),
    );
  });

  it("rejects with anything that is not a call failure", async () => {
    const { commands } = recordingStarts([]);

    await expect(
      startPlay(commands, startArgs({ titleId, episodeId: null }, null, capabilities), MEDIA),
    ).rejects.toThrow("no more starts");
  });
});

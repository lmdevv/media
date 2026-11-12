import { Conflict, NotFound } from "@media/contracts/errors";
import { PlaybackSessionId } from "@media/contracts/ids";
import {
  MediaFileNotFound,
  PlaybackSessionEnded,
  PlaybackTokenInvalid,
  StreamGenerationGone,
  StreamNotFound,
  TranscodeCapacityReached,
  UnsupportedPlayback,
} from "@media/contracts/media-playback";
import { TransportError } from "@media/sdk/effect";
import { describe, expect, it } from "vitest";

import { IOS_CAPABILITIES } from "./capabilities";
import {
  CONNECTION_LOST,
  PlaybackStep,
  PlaybackStop,
  RETRY_LATER_MS,
  STOPPED_MESSAGE,
  afterPlaybackFailure,
  afterPlayerError,
  afterSessionFailure,
  isUnhonoured,
  withoutFailedPath,
} from "./policy";

const transport = new TransportError({
  operation: "movies.play.start",
  message: "Transport failed during movies.play.start: connection refused",
  cause: null,
});

const video = { codec: "hevc", width: 1920, height: 1080, dynamicRange: "sdr" } as const;

describe("afterSessionFailure", () => {
  it("shows File Unavailable when every file of the title is gone", () => {
    expect(afterSessionFailure(new Conflict({ message: "missing from disk" }))).toStrictEqual(
      PlaybackStep.Stop({ stop: PlaybackStop.Missing() }),
    );
  });

  it("says the connection was lost when the server cannot be reached", () => {
    expect(afterSessionFailure(transport)).toStrictEqual(
      PlaybackStep.Stop({ stop: PlaybackStop.Interrupted({ message: CONNECTION_LOST }) }),
    );
  });

  it("shows the server's own words for refusals", () => {
    expect(afterSessionFailure(new NotFound({ message: "No such title" }))).toStrictEqual(
      PlaybackStep.Stop({ stop: PlaybackStop.Interrupted({ message: "No such title" }) }),
    );
  });
});

describe("afterPlaybackFailure", () => {
  it("follows the SDK's recovery for each media service failure", () => {
    expect(
      afterPlaybackFailure(
        new StreamGenerationGone({ streamId: "s", generation: 1, currentGeneration: 2 }),
      ),
    ).toStrictEqual(PlaybackStep.ReloadPlaylist());
    expect(afterPlaybackFailure(new StreamNotFound({ streamId: "s" }))).toStrictEqual(
      PlaybackStep.Renegotiate({ afterMs: 0 }),
    );
    expect(
      afterPlaybackFailure(
        new PlaybackSessionEnded({ sessionId: PlaybackSessionId.make("session") }),
      ),
    ).toStrictEqual(PlaybackStep.NewSession());
    expect(afterPlaybackFailure(new TranscodeCapacityReached({ limit: 2 }))).toStrictEqual(
      PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS }),
    );
    expect(
      afterPlaybackFailure(new UnsupportedPlayback({ reason: "no-transcode-target" })),
    ).toStrictEqual(PlaybackStep.Stop({ stop: PlaybackStop.Unsupported() }));
  });

  it("shows File Unavailable for a file the service cannot find", () => {
    expect(afterPlaybackFailure(new MediaFileNotFound({ fileId: "f" }))).toStrictEqual(
      PlaybackStep.Stop({ stop: PlaybackStop.Missing() }),
    );
  });

  it("starts again with a new ticket when the server refuses the ticket as expired", () => {
    expect(
      afterPlaybackFailure(
        new PlaybackTokenInvalid({ reason: "expired", message: "The ticket expired" }),
      ),
    ).toStrictEqual(PlaybackStep.NewSession());
    expect(
      afterPlaybackFailure(
        new PlaybackTokenInvalid({ reason: "bad_signature", message: "Bad signature" }),
      ),
    ).toStrictEqual(
      PlaybackStep.Stop({ stop: PlaybackStop.Interrupted({ message: STOPPED_MESSAGE }) }),
    );
  });

  it("retries a dropped connection after a pause", () => {
    expect(afterPlaybackFailure(transport)).toStrictEqual(
      PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS }),
    );
  });
});

describe("afterPlayerError", () => {
  it("reloads an HLS stream and drops a direct file for HLS", () => {
    expect(afterPlayerError({ mode: "remux" }, false)).toStrictEqual(PlaybackStep.ReloadPlaylist());
    expect(afterPlayerError({ mode: "transcode-software" }, false)).toStrictEqual(
      PlaybackStep.ReloadPlaylist(),
    );
    expect(afterPlayerError({ mode: "direct" }, false)).toStrictEqual(PlaybackStep.TryAnotherWay());
  });

  it("drops the path when a reloaded HLS stream fails again", () => {
    expect(afterPlayerError({ mode: "remux" }, true)).toStrictEqual(PlaybackStep.TryAnotherWay());
  });
});

describe("withoutFailedPath", () => {
  it("drops direct play after a direct file failed", () => {
    expect(
      withoutFailedPath(IOS_CAPABILITIES, { mode: "direct", video })?.containers,
    ).toStrictEqual([]);
  });

  it("drops a copied codec but never H.264", () => {
    expect(
      withoutFailedPath(IOS_CAPABILITIES, { mode: "remux", video })?.videoCodecs.map(
        (support) => support.codec,
      ),
    ).toStrictEqual(["h264"]);
    expect(
      withoutFailedPath(IOS_CAPABILITIES, { mode: "remux", video: { ...video, codec: "h264" } }),
    ).toBeNull();
  });

  it("has nothing to drop after a transcode failed", () => {
    expect(withoutFailedPath(IOS_CAPABILITIES, { mode: "transcode-software", video })).toBeNull();
  });
});

describe("isUnhonoured", () => {
  it("names the answers that a stream without the quality cap or picture subtitle may avoid", () => {
    expect(isUnhonoured(new TranscodeCapacityReached({ limit: 2 }))).toBe(true);
    expect(isUnhonoured(new StreamNotFound({ streamId: "s" }))).toBe(false);
    expect(isUnhonoured(transport)).toBe(false);
  });
});

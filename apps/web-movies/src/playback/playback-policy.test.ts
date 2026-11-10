import { Conflict, NotFound } from "@media/contracts/errors";
import {
  MediaFileNotFound,
  PlaybackSessionEnded,
  StreamGenerationGone,
  StreamNotFound,
  TranscodeCapacityReached,
  UnsupportedPlayback,
} from "@media/contracts/media-playback";
import { PlaybackSessionId } from "@media/contracts/ids";
import { PlaybackTokenInvalid } from "@media/contracts/playback-token";
import { TransportError } from "@media/sdk/effect";
import { describe, expect, it } from "vitest";

import {
  PlaybackStep,
  PlaybackStop,
  RETRY_LATER_MS,
  STOPPED_MESSAGE,
  afterPlaybackFailure,
  afterSessionFailure,
  afterStreamFailure,
  offersResume,
} from "./playback-policy";

const transport = new TransportError({
  operation: "playback.negotiate",
  message: "Transport failed during playback.negotiate: connection refused",
  cause: null,
});

describe("afterSessionFailure", () => {
  it("shows the missing-file state when every file of the title is gone", () => {
    expect(afterSessionFailure(new Conflict({ message: "missing from disk" }))).toStrictEqual(
      PlaybackStep.Stop({ stop: PlaybackStop.Missing() }),
    );
  });

  it("shows the server's own words for refusals", () => {
    expect(afterSessionFailure(new NotFound({ message: "No such title" }))).toStrictEqual(
      PlaybackStep.Stop({ stop: PlaybackStop.Failed({ message: "No such title" }) }),
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
    expect(afterPlaybackFailure(transport)).toStrictEqual(
      PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS }),
    );
    expect(
      afterPlaybackFailure(new UnsupportedPlayback({ reason: "no-transcode-target" })),
    ).toStrictEqual(PlaybackStep.Stop({ stop: PlaybackStop.Unsupported() }));
  });

  it("shows the missing-file state for a file the media service cannot find", () => {
    expect(afterPlaybackFailure(new MediaFileNotFound({ fileId: "file" }))).toStrictEqual(
      PlaybackStep.Stop({ stop: PlaybackStop.Missing() }),
    );
  });

  it("starts again, with a new ticket, when the server refuses the ticket as expired", () => {
    expect(
      afterPlaybackFailure(
        new PlaybackTokenInvalid({ reason: "expired", message: "The ticket expired" }),
      ),
    ).toStrictEqual(PlaybackStep.NewSession());
  });

  it("stops on a ticket refused for any other reason", () => {
    expect(
      afterPlaybackFailure(
        new PlaybackTokenInvalid({ reason: "bad_signature", message: "Bad signature" }),
      ),
    ).toStrictEqual(PlaybackStep.Stop({ stop: PlaybackStop.Failed({ message: STOPPED_MESSAGE }) }));
  });
});

describe("afterStreamFailure", () => {
  it("reloads the playlist for a replaced generation and renegotiates a lost stream", () => {
    expect(afterStreamFailure({ kind: "http", status: 410 })).toStrictEqual(
      PlaybackStep.ReloadPlaylist(),
    );
    expect(afterStreamFailure({ kind: "http", status: 404 })).toStrictEqual(
      PlaybackStep.Renegotiate({ afterMs: 0 }),
    );
    expect(afterStreamFailure({ kind: "http", status: 401 })).toStrictEqual(
      PlaybackStep.Renegotiate({ afterMs: 0 }),
    );
  });

  it("tries another way after a decode failure and waits out a busy service", () => {
    expect(afterStreamFailure({ kind: "media" })).toStrictEqual(PlaybackStep.TryAnotherWay());
    expect(afterStreamFailure({ kind: "http", status: 503 })).toStrictEqual(
      PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS }),
    );
    expect(afterStreamFailure({ kind: "network" })).toStrictEqual(
      PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS }),
    );
  });
});

describe("offersResume", () => {
  it("asks only when the saved position is worth resuming", () => {
    expect([0, 450, 9_999, 10_000, 1_500_000].map(offersResume)).toStrictEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
  });
});

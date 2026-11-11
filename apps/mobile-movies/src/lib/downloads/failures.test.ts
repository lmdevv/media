import { PlaybackSessionId } from "@media/contracts/ids";
import {
  PlaybackSessionEnded,
  TranscodeCapacityReached,
  TranscodeFailed,
} from "@media/contracts/media-playback";
import { PlaybackTokenInvalid } from "@media/contracts/playback-token";
import { Forbidden, NotFound } from "@media/contracts/errors";
import { TransportError } from "@media/sdk/effect";
import { describe, expect, it } from "vitest";

import { DownloadStep, SERVER_UNAVAILABLE, afterDownloadFailure, failureLine } from "./failures";

describe("afterDownloadFailure", () => {
  it("fetches a new ticket for an expired or ended one, and waits out a busy server", () => {
    expect(
      afterDownloadFailure(new PlaybackTokenInvalid({ reason: "expired", message: "expired" })),
    ).toStrictEqual(DownloadStep.Refetch());
    expect(
      afterDownloadFailure(
        new PlaybackSessionEnded({ sessionId: PlaybackSessionId.make("session") }),
      ),
    ).toStrictEqual(DownloadStep.Refetch());
    expect(afterDownloadFailure(new TranscodeCapacityReached({ limit: 2 }))).toStrictEqual(
      DownloadStep.Wait(),
    );
  });

  it("stops with H19's line for what the viewer can only retry", () => {
    expect(
      afterDownloadFailure(
        new TransportError({ operation: "downloads.prepare", message: "offline", cause: null }),
      ),
    ).toStrictEqual(DownloadStep.Interrupt({ message: SERVER_UNAVAILABLE }));
    expect(
      afterDownloadFailure(new TranscodeFailed({ streamId: "k", mode: "remux", detail: "x" })),
    ).toStrictEqual(
      DownloadStep.Interrupt({ message: "Your server couldn't prepare this download." }),
    );
    expect(afterDownloadFailure(new NotFound({ message: "No such item" }))).toStrictEqual(
      DownloadStep.Interrupt({ message: "No such item" }),
    );
  });

  it("shows the core's refusal, and the server's line for what it would retry", () => {
    expect(failureLine(new Forbidden({ message: "Guests cannot download" }))).toBe(
      "Guests cannot download",
    );
    expect(failureLine(new TranscodeCapacityReached({ limit: 2 }))).toBe(SERVER_UNAVAILABLE);
    expect(failureLine("broken")).toBe("Download stopped. Try again.");
  });
});

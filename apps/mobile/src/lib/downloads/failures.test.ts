import { PlaybackSessionId } from "@media/contracts/ids";
import { PlaybackSessionEnded, TranscodeFailed } from "@media/contracts/media-playback";
import { PlaybackTokenInvalid } from "@media/contracts/playback-token";
import { NotFound } from "@media/contracts/errors";
import { TransportError } from "@media/sdk/effect";
import { describe, expect, it } from "vitest";

import { DownloadStep, SERVER_UNAVAILABLE, afterDownloadFailure } from "./failures";

describe("afterDownloadFailure", () => {
  it("renews an expired token and starts a new session for an ended one", () => {
    expect(
      afterDownloadFailure(new PlaybackTokenInvalid({ reason: "expired", message: "expired" })),
    ).toStrictEqual(DownloadStep.Renew());
    expect(
      afterDownloadFailure(
        new PlaybackSessionEnded({ sessionId: PlaybackSessionId.make("session") }),
      ),
    ).toStrictEqual(DownloadStep.Restart());
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
    expect(
      afterDownloadFailure(new NotFound({ message: "This profile can't see this title" })),
    ).toStrictEqual(DownloadStep.Interrupt({ message: "This profile can't see this title" }));
  });
});

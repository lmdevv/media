import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PlaybackApiError, TranscodeFailed } from "@media/contracts/media-playback";

import { PlaybackRefused, reportOf } from "./cli-errors";

/** The report of a transcode that failed for `reason`, as the media service's answer gave it. */
const refusedFor = (reason: string) =>
  reportOf(
    new PlaybackRefused({
      error: Schema.decodeSync(PlaybackApiError)({
        _tag: "TranscodeFailed",
        streamId: "s1",
        mode: "transcode-qsv",
        reason,
      }),
      recovery: "fail",
    }),
  );

describe("reportOf", () => {
  it("says why a transcode failed in words, never ffmpeg's", () => {
    const refused = new PlaybackRefused({
      error: new TranscodeFailed({ streamId: "s1", mode: "transcode-qsv", reason: "disk-full" }),
      recovery: "fail",
    });

    expect(reportOf(refused)).toStrictEqual({
      code: "playback_fail",
      message:
        "The media service refused to play: the transcode in transcode-qsv failed: disk full",
    });
  });

  it("reports a reason a newer server added as it reports other", () => {
    expect(refusedFor("driver-reset")).toStrictEqual(refusedFor("other"));
  });
});

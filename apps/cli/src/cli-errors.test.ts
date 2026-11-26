import { describe, expect, it } from "vitest";

import { TranscodeFailed } from "@media/contracts/media-playback";

import { PlaybackRefused, reportOf } from "./cli-errors";

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
});

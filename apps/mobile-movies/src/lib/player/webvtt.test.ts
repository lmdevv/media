import { describe, expect, it } from "vitest";

import { cuesAt, parseWebVtt } from "./webvtt";

const FILE = `﻿WEBVTT
Kind: captions

NOTE made by ffmpeg

STYLE
::cue { color: yellow }

1
00:00:01.000 --> 00:00:04.000 line:90%
<v Sintel>You're a <i>brave</i> one,
&lt;little&gt; scale &amp; all.

00:00:03.500 --> 00:00:05.250
<c.loud>Two at once</c>

01:02:03,450 --> 01:02:04.000
Late

00:00:09.000 --> 00:00:08.000
Backwards

00:00:10.000 --> 00:00:11.000
<i></i>
`;

describe("parseWebVtt", () => {
  const cues = parseWebVtt(FILE.replaceAll("\n", "\r\n"));

  it("reads cues and skips notes, styles, and empty or backwards cues", () => {
    expect(cues.map((cue) => [cue.start, cue.end])).toStrictEqual([
      [1, 4],
      [3.5, 5.25],
      [3723.45, 3724],
    ]);
  });

  it("keeps italics and drops other tags and voices, decoding entities", () => {
    expect(cues[0]?.lines).toStrictEqual([
      [
        { text: "You're a ", italic: false },
        { text: "brave", italic: true },
        { text: " one,", italic: false },
      ],
      [{ text: "<little> scale & all.", italic: false }],
    ]);
    expect(cues[1]?.lines).toStrictEqual([[{ text: "Two at once", italic: false }]]);
  });
});

describe("parseWebVtt without blank lines", () => {
  it("starts a cue at each timing line, as the media service writes them", () => {
    const cues = parseWebVtt(
      "WEBVTT\n01:47.250 --> 01:49.220\nThis blade has a dark past.\n01:58.000 --> 02:01.450\nYou're a fool for traveling alone,\nso completely unprepared.\n",
    );

    expect(cues.map((cue) => [cue.start, cue.lines.length])).toStrictEqual([
      [107.25, 1],
      [118, 2],
    ]);
  });
});

describe("cuesAt", () => {
  const cues = parseWebVtt(FILE);

  it("shows every cue active at the position, until its end", () => {
    expect(cuesAt(cues, 0.5, 0)).toHaveLength(0);
    expect(cuesAt(cues, 1, 0)).toHaveLength(1);
    expect(cuesAt(cues, 3.75, 0)).toHaveLength(2);
    expect(cuesAt(cues, 4, 0)).toHaveLength(1);
  });

  it("moves cues later for a positive delay and earlier for a negative one", () => {
    expect(cuesAt(cues, 1.2, 500)).toHaveLength(0);
    expect(cuesAt(cues, 1.5, 500)).toHaveLength(1);
    expect(cuesAt(cues, 0.6, -500)).toHaveLength(1);
  });
});

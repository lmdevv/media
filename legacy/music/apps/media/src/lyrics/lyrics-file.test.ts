import { type Lang, LyricBody, type LyricsFormat, parseLang } from "@music/commands/lyrics";
import { Result } from "effect";
import { describe, expect, it } from "vitest";

import { parseLyricsFile } from "./lyrics-file.ts";

const en = parseLang("en");

const setsOf = (format: LyricsFormat, text: string, lang: Lang | null = null) =>
  Result.getOrThrow(parseLyricsFile(format, text, lang));

const bodyOf = (format: LyricsFormat, text: string): LyricBody => setsOf(format, text)[0].body;

const failureOf = (format: LyricsFormat, text: string) =>
  Result.match(parseLyricsFile(format, text, null), {
    onSuccess: () => undefined,
    onFailure: (error) => error.reason,
  });

const timed = LyricBody.match({
  Synced: ({ lines }): ReadonlyArray<unknown> => lines.map((line) => [line.startMs, line.text]),
  Plain: ({ text }) => [text],
});

describe("parseLyricsFile: LRC", () => {
  it("reads every fraction style, minutes past 59, and ignores ID tags", () => {
    const body = bodyOf(
      "lrc",
      [
        "[ar:Aurora Tones]",
        "[ti:Dawn]",
        "[by:someone]",
        "[length: 63:12]",
        "[00:01]Whole seconds",
        "[00:02.5]Tenths",
        "[00:03.25]Hundredths",
        "[00:04.125]Milliseconds",
        "[00:05:50]Colon hundredths",
        "[61:02.00]An hour in",
      ].join("\n"),
    );

    expect(timed(body)).toEqual([
      [1000, "Whole seconds"],
      [2500, "Tenths"],
      [3250, "Hundredths"],
      [4125, "Milliseconds"],
      [5500, "Colon hundredths"],
      [3_662_000, "An hour in"],
    ]);
  });

  it("repeats a line with several stamps and sorts lines by time", () => {
    const body = bodyOf(
      "lrc",
      "[00:10.00][00:30.00]Chorus\n[00:20.00]Verse two\n[00:05.00]Verse one\n",
    );

    expect(timed(body)).toEqual([
      [5000, "Verse one"],
      [10_000, "Chorus"],
      [20_000, "Verse two"],
      [30_000, "Chorus"],
    ]);
  });

  it("keeps one copy of a repeated line and stacks different lines that share a stamp", () => {
    const body = bodyOf(
      "lrc",
      "[00:01.00]Hello\n[00:01.00]Hello\n[00:02.00]Original\n[00:02.00]Translation\n[00:03.00]End",
    );

    expect(timed(body)).toEqual([
      [1000, "Hello"],
      [2000, "Original\nTranslation"],
      [3000, "End"],
    ]);
  });

  it("reads stamps separated by spaces and never shows a word stamp as text", () => {
    expect(timed(bodyOf("lrc", "[00:01.00] [00:04.00]Twice\n[00:06.00]After"))).toEqual([
      [1000, "Twice"],
      [4000, "Twice"],
      [6000, "After"],
    ]);
    expect(
      bodyOf("elrc", "[00:01.00]<00:01.00>Sung<00:02.00>\n[00:05.00]<00:05.00>\n[00:09.00]Next"),
    ).toMatchObject({
      lines: [
        { text: "Sung", startMs: 1000, endMs: 2000 },
        { text: "Next", startMs: 9000 },
      ],
    });
    expect(bodyOf("lrc", "[00:01.00]Sung\n[00:05.00]<00:05.00>\n[00:09.00]Next")).toMatchObject({
      lines: [
        { text: "Sung", startMs: 1000, endMs: 5000 },
        { text: "Next", startMs: 9000 },
      ],
    });
  });

  it("keeps word timing only on the repeat of a line its word stamps fall in", () => {
    const body = bodyOf(
      "elrc",
      "[00:01.00][00:10.00]<00:01.00>Hello<00:02.00> world<00:03.00>\n[00:12.00]\n[00:14.00]End",
    );

    expect(body).toMatchObject({
      lines: [
        {
          text: "Hello world",
          startMs: 1000,
          endMs: 3000,
          words: [
            { text: "Hello", startMs: 1000, endMs: 2000 },
            { text: " world", startMs: 2000, endMs: 3000 },
          ],
        },
        { text: "Hello world", startMs: 10_000, endMs: 12_000, words: null },
        { text: "End", startMs: 14_000 },
      ],
    });

    expect(bodyOf("elrc", "[00:01.00][00:02.00]<00:03.00>Hi<00:04.00>")).toMatchObject({
      lines: [
        { text: "Hi", startMs: 1000, endMs: null, words: null },
        { text: "Hi", startMs: 2000, endMs: 4000, words: [{ startMs: 3000, endMs: 4000 }] },
      ],
    });
  });

  it("reads a translation paired under every line as its own set", () => {
    const sets = setsOf(
      "lrc",
      [
        "[00:01.00]<00:01.00>こん<00:01.50>にちは",
        "[00:01.00]Hello",
        "[00:03.00]さようなら",
        "[00:03.00]Goodbye",
        "[00:05.00]",
      ].join("\n"),
      parseLang("ja"),
    );

    expect(sets).toEqual([
      {
        kind: "main",
        lang: "ja",
        body: {
          _tag: "Synced",
          lines: [
            {
              text: "こんにちは",
              startMs: 1000,
              endMs: null,
              words: [
                { text: "こん", startMs: 1000, endMs: 1500 },
                { text: "にちは", startMs: 1500, endMs: null },
              ],
              voice: null,
            },
            { text: "さようなら", startMs: 3000, endMs: 5000, words: null, voice: null },
          ],
        },
      },
      {
        kind: "translation",
        lang: null,
        body: {
          _tag: "Synced",
          lines: [
            { text: "Hello", startMs: 1000, endMs: null, words: null, voice: null },
            { text: "Goodbye", startMs: 3000, endMs: 5000, words: null, voice: null },
          ],
        },
      },
    ]);
  });

  it("moves stamps earlier for a positive offset and later for a negative one", () => {
    expect(timed(bodyOf("lrc", "[offset:+500]\n[00:02.00]A\n[00:03.00]B"))).toEqual([
      [1500, "A"],
      [2500, "B"],
    ]);
    expect(timed(bodyOf("lrc", "[offset:-250]\n[00:02.00]A\n[00:03.00]B"))).toEqual([
      [2250, "A"],
      [3250, "B"],
    ]);
    expect(timed(bodyOf("lrc", "[offset:+5000]\n[00:02.00]A\n[00:09.00]B"))).toEqual([
      [0, "A"],
      [4000, "B"],
    ]);
  });

  it("reads CRLF and CR line endings", () => {
    expect(timed(bodyOf("lrc", "[00:01.00]A\r\n[00:02.00]B\r\n"))).toEqual([
      [1000, "A"],
      [2000, "B"],
    ]);
    expect(timed(bodyOf("lrc", "[00:01.00]A\r[00:02.00]B\r"))).toEqual([
      [1000, "A"],
      [2000, "B"],
    ]);
  });

  it("ends a line at an empty stamped line instead of showing a blank one", () => {
    const body = bodyOf("lrc", "[00:01.00]Sung\n[00:04.00]\n[00:10.00]Again");

    expect(body).toMatchObject({
      lines: [
        { text: "Sung", startMs: 1000, endMs: 4000 },
        { text: "Again", startMs: 10_000, endMs: null },
      ],
    });
  });

  it("reads A2 word stamps and never invents words for lines without them", () => {
    const body = bodyOf(
      "elrc",
      "[00:12.00]<00:12.00>Hel<00:12.40>lo <00:12.90>world<00:13.50>\n[00:14.00]No words here",
    );

    expect(body).toMatchObject({
      lines: [
        {
          text: "Hello world",
          startMs: 12_000,
          endMs: 13_500,
          words: [
            { text: "Hel", startMs: 12_000, endMs: 12_400 },
            { text: "lo ", startMs: 12_400, endMs: 12_900 },
            { text: "world", startMs: 12_900, endMs: 13_500 },
          ],
        },
        { text: "No words here", words: null, endMs: null },
      ],
    });
  });

  it("gives a space timed on its own to the word before it", () => {
    const body = bodyOf("elrc", "[00:01.00] <00:01.00>One<00:01.50> <00:02.00>two\n[00:03.00]x");

    expect(body).toMatchObject({
      lines: [
        {
          text: "One two",
          words: [
            { text: "One ", startMs: 1000, endMs: 1500 },
            { text: "two", startMs: 2000, endMs: null },
          ],
        },
        {},
      ],
    });
  });

  it("starts unstamped leading text with the line and shifts word stamps by the offset", () => {
    const body = bodyOf("lrc", "[offset:100]\n[00:01.00]Oh <00:01.50>yeah\n[00:03.00]Next");

    expect(body).toMatchObject({
      lines: [
        {
          startMs: 900,
          words: [
            { text: "Oh ", startMs: 900, endMs: 1400 },
            { text: "yeah", startMs: 1400, endMs: null },
          ],
        },
        { startMs: 2900 },
      ],
    });
  });

  it("reads singer prefixes, which carry to the lines after them", () => {
    const body = bodyOf("lrc", "[00:01.00]M: First\n[00:02.00]Still him\n[00:03.00]F: Her\n");

    expect(body).toMatchObject({
      lines: [
        { text: "First", voice: "M" },
        { text: "Still him", voice: "M" },
        { text: "Her", voice: "F" },
      ],
    });
    expect(bodyOf("elrc", "[00:01.00]v1:<00:01.00>One\n[00:02.00]v2:Two")).toMatchObject({
      lines: [
        { text: "One", voice: "v1" },
        { text: "Two", voice: "v2" },
      ],
    });
  });

  it("reads stamps that are all zero, or all the same, as plain lyrics", () => {
    expect(bodyOf("lrc", "[00:00.00]First line\n[00:00.00]Second line")).toEqual({
      _tag: "Plain",
      text: "First line\nSecond line",
    });
    expect(bodyOf("lrc", "[ar:Someone]\n[00:07.00]Only\n[00:07.00]Same")).toEqual({
      _tag: "Plain",
      text: "Only\nSame",
    });
  });

  it("reads a file without stamps as plain lyrics, and keeps credit lines", () => {
    expect(bodyOf("lrc", "[ti:Song]\nJust words\n\n\n\nMore words  ")).toEqual({
      _tag: "Plain",
      text: "Just words\n\nMore words",
    });
    expect(timed(bodyOf("lrc", "[00:00.00]Lyrics by: Someone\n[00:05.00]First line"))).toEqual([
      [0, "Lyrics by: Someone"],
      [5000, "First line"],
    ]);
  });

  it("never reads instrumental from the text", () => {
    expect(bodyOf("txt", "[Instrumental]")).toEqual({ _tag: "Plain", text: "[Instrumental]" });
  });

  it("trims the spaces around a line's words, so its words spell the line", () => {
    expect(
      bodyOf("elrc", "[00:01.00]<00:01.00> Hello <00:02.00>world <00:03.00>\n[00:04.00]x"),
    ).toMatchObject({
      lines: [
        {
          text: "Hello world",
          words: [
            { text: "Hello ", startMs: 1000, endMs: 2000 },
            { text: "world", startMs: 2000, endMs: 3000 },
          ],
        },
        {},
      ],
    });
  });

  it("drops word timing that runs backwards or falls outside its line, and keeps the line", () => {
    const body = bodyOf(
      "elrc",
      "[00:01.00]<00:01.00>One <00:03.00>two <00:02.00>three\n[00:05.00]<00:01.00>Early <00:02.00>words\n[00:08.00]Next",
    );

    expect(body).toMatchObject({
      lines: [
        { text: "One two three", startMs: 1000, words: null },
        { text: "Early words", startMs: 5000, words: null },
        { text: "Next", startMs: 8000 },
      ],
    });
  });

  it("fails for a file with only ID tags", () => {
    expect(failureOf("lrc", "[ar:Someone]\n[ti:Song]\n")).toBe("empty");
  });

  it("fails for a set longer than 2,000 lines", () => {
    const text = Array.from(
      { length: 2001 },
      (_, index) => `[${Math.floor(index / 60)}:${index % 60}.00]x${index}`,
    );

    expect(failureOf("lrc", text.join("\n"))).toBe("too-long");
  });

  it("fails fast for one line stamped past 2,000 times, before reading its words", () => {
    const half = 128 * 1024;
    const line = "[0:0]".repeat(half / 5) + "<0:0>a".repeat(half / 6);

    expect(failureOf("elrc", line)).toBe("too-long");
  });

  it("fails for a line with more than 500 word stamps", () => {
    const stamps = Array.from(
      { length: 2000 },
      (_, index) => `[${Math.floor(index / 60)}:${index % 60}]`,
    );

    const words = "<59:59>a".repeat(501);

    expect(failureOf("elrc", stamps.join("") + words)).toBe("too-long");
    expect(failureOf("elrc", `[0:01]${"<0:02>a".repeat(500)}`)).toBeUndefined();
  });
});

describe("parseLyricsFile: plain text", () => {
  it("reads a .txt file as plain lyrics, or as LRC when it holds stamps", () => {
    expect(bodyOf("txt", "Line one\r\nLine two\r\n")).toEqual({
      _tag: "Plain",
      text: "Line one\nLine two",
    });
    expect(timed(bodyOf("txt", "[00:01.00]One\n[00:02.00]Two"))).toEqual([
      [1000, "One"],
      [2000, "Two"],
    ]);
  });

  it("names the set's language from the file name", () => {
    expect(setsOf("txt", "Hallo", parseLang("de"))).toEqual([
      { kind: "main", lang: "de", body: { _tag: "Plain", text: "Hallo" } },
    ]);
  });

  it("fails for blank text", () => {
    expect(failureOf("txt", " \n\n \t")).toBe("empty");
  });
});

describe("parseLyricsFile: WebVTT", () => {
  it("reads cues with hours or without, cue settings, notes, and markup", () => {
    const body = bodyOf(
      "vtt",
      [
        "WEBVTT - lyrics",
        "",
        "NOTE written by hand",
        "",
        "STYLE",
        "::cue { color: red }",
        "",
        "intro",
        "00:00:01.000 --> 00:00:03.500 align:start position:10%",
        "<v Lead Singer>First <i>line</i> &amp; more",
        "",
        "00:04.000 --> 00:06.000",
        "<c.yellow>Second</c>",
        "second row",
      ].join("\n"),
    );

    expect(body).toMatchObject({
      lines: [
        {
          text: "First line & more",
          startMs: 1000,
          endMs: 3500,
          voice: "Lead Singer",
          words: null,
        },
        { text: "Second\nsecond row", startMs: 4000, endMs: 6000, voice: null },
      ],
    });
  });

  it("reads inline timestamps as word timing", () => {
    const body = bodyOf(
      "vtt",
      "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOne <00:00:01.500>two <00:00:02.200>three",
    );

    expect(body).toMatchObject({
      lines: [
        {
          text: "One two three",
          words: [
            { text: "One ", startMs: 1000, endMs: 1500 },
            { text: "two ", startMs: 1500, endMs: 2200 },
            { text: "three", startMs: 2200, endMs: 3000 },
          ],
        },
      ],
    });
  });

  it("drops an end before its cue's start and word stamps outside the cue", () => {
    const body = bodyOf(
      "vtt",
      "WEBVTT\n\n00:00:05.000 --> 00:00:04.000\nBackwards\n\n00:00:06.000 --> 00:00:07.000\nOne <00:00:09.000>two",
    );

    expect(body).toMatchObject({
      lines: [
        { text: "Backwards", startMs: 5000, endMs: null },
        { text: "One two", startMs: 6000, endMs: 7000, words: null },
      ],
    });
  });

  it("keeps a numeric character reference past Unicode as written", () => {
    expect(bodyOf("vtt", "WEBVTT\n\n00:01.000 --> 00:02.000\nA &#xFFFFFFFF; &#233;")).toMatchObject(
      {
        lines: [{ text: "A &#xFFFFFFFF; é" }],
      },
    );
    expect(bodyOf("srt", "1\n00:00:01,000 --> 00:00:02,000\nB &#1114112;")).toMatchObject({
      lines: [{ text: "B &#1114112;" }],
    });
  });

  it("fails without the WEBVTT header", () => {
    expect(failureOf("vtt", "00:00:01.000 --> 00:00:02.000\nHi")).toBe("malformed");
  });
});

describe("parseLyricsFile: SubRip", () => {
  it("reads comma decimals, removes markup, and keeps multi-line cues together", () => {
    const body = bodyOf(
      "srt",
      [
        "1",
        "00:00:01,000 --> 00:00:02,500",
        "<i>Hello</i>",
        "",
        "2",
        "00:00:03,250 --> 00:00:05,000",
        '{\\an8}<font color="#ffffff">Top</font>',
        "and bottom",
        "",
      ].join("\r\n"),
    );

    expect(body).toMatchObject({
      lines: [
        { text: "Hello", startMs: 1000, endMs: 2500, words: null },
        { text: "Top\nand bottom", startMs: 3250, endMs: 5000 },
      ],
    });
  });

  it("fails without any cue", () => {
    expect(failureOf("srt", "just some words")).toBe("empty");
  });
});

const appleTtml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="ja">
  <head>
    <metadata>
      <ttm:agent type="person" xml:id="v1"/>
      <iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">
        <translations>
          <translation type="replacement" xml:lang="en">
            <text for="L1">Hello world</text>
            <text for="L2">Goodbye</text>
          </translation>
        </translations>
        <transliterations>
          <transliteration xml:lang="ja-Latn">
            <text for="L1"><span begin="1.000" end="1.400">kon</span><span begin="1.400" end="2.000">nichiwa</span></text>
          </transliteration>
        </transliterations>
      </iTunesMetadata>
    </metadata>
  </head>
  <body dur="10.000">
    <div begin="1.000" end="9.000">
      <p begin="00:01.000" end="00:02.500" itunes:key="L1" ttm:agent="v1"><span begin="00:01.000" end="00:01.400">こん</span><span begin="00:01.400" end="00:02.000">にちは</span> <span begin="00:02.000" end="00:02.500">世界</span></p>
      <p begin="3.5s" dur="1500ms" itunes:key="L2">さようなら<br/>またね</p>
    </div>
  </body>
</tt>`;

describe("parseLyricsFile: TTML", () => {
  it("reads lines, word spans, singers, and the document language", () => {
    const [main] = setsOf("ttml", appleTtml);

    expect(main).toMatchObject({
      kind: "main",
      lang: "ja",
      body: {
        _tag: "Synced",
        lines: [
          {
            text: "こんにちは 世界",
            startMs: 1000,
            endMs: 2500,
            voice: "v1",
            words: [
              { text: "こん", startMs: 1000, endMs: 1400 },
              { text: "にちは ", startMs: 1400, endMs: 2000 },
              { text: "世界", startMs: 2000, endMs: 2500 },
            ],
          },
          { text: "さようなら\nまたね", startMs: 3500, endMs: 5000, words: null, voice: null },
        ],
      },
    });
  });

  it("reads Apple translations and transliterations onto the main lines' timing", () => {
    const [, translation, transliteration] = setsOf("ttml", appleTtml);

    expect(translation).toMatchObject({
      kind: "translation",
      lang: "en",
      body: {
        lines: [
          { text: "Hello world", startMs: 1000, endMs: 2500, words: null },
          { text: "Goodbye", startMs: 3500, endMs: 5000 },
        ],
      },
    });
    expect(transliteration).toMatchObject({
      kind: "pronunciation",
      lang: "ja-Latn",
      body: {
        lines: [
          {
            text: "konnichiwa",
            words: [
              { text: "kon", startMs: 1000 },
              { text: "nichiwa", startMs: 1400 },
            ],
          },
        ],
      },
    });
  });

  it("treats line breaks in the markup as spaces, and only <br/> as a line break", () => {
    const body = bodyOf(
      "ttml",
      `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
        <p begin="1s" end="2s">
          <span begin="0s" end="0.5s">Two</span>
          <span begin="0.5s" end="1s">words</span>
        </p>
        <p begin="3s">Up<br/>
          down</p>
      </div></body></tt>`,
    );

    expect(body).toMatchObject({
      lines: [
        {
          text: "Two words",
          words: [
            { text: "Two ", startMs: 1000, endMs: 1500 },
            { text: "words", startMs: 1500, endMs: 2000 },
          ],
        },
        { text: "Up\ndown", words: null },
      ],
    });
  });

  it("prefers the language in the file name over the document's", () => {
    expect(setsOf("ttml", appleTtml, en)[0]).toMatchObject({ lang: "en" });
  });

  it("reads clock times with hours and frames, and offset times", () => {
    const body = bodyOf(
      "ttml",
      `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="25">
        <body><div>
          <p begin="00:00:01:05" end="00:00:02.000">Frames</p>
          <p begin="0.05h" end="181s">Hours</p>
          <p begin="1:00:00.250">Clock</p>
        </div></body></tt>`,
    );

    expect(timed(body)).toEqual([
      [1200, "Frames"],
      [180_000, "Hours"],
      [3_600_250, "Clock"],
    ]);
  });

  it("reads untimed lines as plain lyrics", () => {
    expect(
      bodyOf(
        "ttml",
        `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p>One</p><p>Two</p></div></body></tt>`,
      ),
    ).toEqual({ _tag: "Plain", text: "One\nTwo" });
  });

  it("times each element from its parent's start, as TTML defines", () => {
    const body = bodyOf(
      "ttml",
      `<tt xmlns="http://www.w3.org/ns/ttml"><body begin="2s"><div begin="8s">
        <p begin="1s" end="3s"><span begin="0s" end="1s">Hel</span><span begin="1s" dur="500ms">lo</span></p>
        <p begin="4s" end="9s" dur="2s">Shorter of end and dur</p>
      </div></body></tt>`,
    );

    expect(body).toMatchObject({
      lines: [
        {
          text: "Hello",
          startMs: 11_000,
          endMs: 13_000,
          words: [
            { text: "Hel", startMs: 11_000, endMs: 12_000 },
            { text: "lo", startMs: 12_000, endMs: 12_500 },
          ],
        },
        { text: "Shorter of end and dur", startMs: 14_000, endMs: 16_000 },
      ],
    });
  });

  it("times each child of a seq container after the one before it", () => {
    const body = bodyOf(
      "ttml",
      `<tt xmlns="http://www.w3.org/ns/ttml"><body><div begin="1s" timeContainer="seq">
        <p dur="2s">First</p>
        <p begin="1s" dur="3s">Second</p>
      </div></body></tt>`,
    );

    expect(timed(body)).toEqual([
      [1000, "First"],
      [4000, "Second"],
    ]);
  });

  it("leaves background vocals out of the line they echo", () => {
    const [main] = setsOf(
      "ttml",
      `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"
          xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
        <body><div begin="1.000">
          <p begin="1.000" end="3.000"><span begin="1.000" end="2.000">Lead</span> <span ttm:role="x-bg"><span begin="1.500" end="2.500">(echo)</span></span></p>
          <p begin="4.000" end="5.000">Next</p>
        </div></body></tt>`,
    );

    expect(main.body).toMatchObject({
      lines: [
        { text: "Lead", startMs: 1000, words: [{ text: "Lead", startMs: 1000, endMs: 2000 }] },
        { text: "Next", startMs: 4000 },
      ],
    });
  });

  it("fails for elements nested too deeply to read", () => {
    const depth = 4000;

    expect(
      failureOf(
        "ttml",
        `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s">${"<span>".repeat(depth)}x${"</span>".repeat(depth)}</p></div></body></tt>`,
      ),
    ).toBe("malformed");
  });

  it("refuses a DTD, so external entities are never read", () => {
    const attack = `<?xml version="1.0"?>
<!DOCTYPE tt [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s">&secret;</p><p begin="2s">x</p></div></body></tt>`;

    const result = parseLyricsFile("ttml", attack, null);

    expect(Result.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("root:");
    expect(failureOf("ttml", attack)).toBe("malformed");
  });

  it("fails for XML that is not well formed, or is not TTML", () => {
    expect(failureOf("ttml", "<tt><body><p begin='1s'>open")).toBe("malformed");

    const detail = Result.match(parseLyricsFile("ttml", "<tt><p>&unknown;</p></tt>", null), {
      onSuccess: () => "",
      onFailure: (error) => error.detail,
    });

    expect(detail).toBe("entity not found:&unknown;");
    expect(failureOf("ttml", "<html><body>hi</body></html>")).toBe("malformed");
  });
});

const lyricsfile = `version: '1.0'
metadata:
  title: 'Example Song'
  artist: 'Example Artist'
  language: 'en'
lines:
  - text: 'Hello world'
    start_ms: 1200
    end_ms: 2800
    words:
      - text: 'Hello '
        start_ms: 1200
        end_ms: 1900
      - text: 'world'
        start_ms: 1900
        end_ms: 2800
  - text: 'Second line'
    start_ms: 3000
plain: |
  Hello world
  Second line
`;

describe("parseLyricsFile: Lyricsfile", () => {
  it("reads timed lines with word timing and the metadata language", () => {
    expect(setsOf("lyricsfile", lyricsfile)).toEqual([
      {
        kind: "main",
        lang: "en",
        body: {
          _tag: "Synced",
          lines: [
            {
              text: "Hello world",
              startMs: 1200,
              endMs: 2800,
              words: [
                { text: "Hello ", startMs: 1200, endMs: 1900 },
                { text: "world", startMs: 1900, endMs: 2800 },
              ],
              voice: null,
            },
            { text: "Second line", startMs: 3000, endMs: null, words: null, voice: null },
          ],
        },
      },
    ]);
  });

  it("reads the plain version when there are no timed lines", () => {
    expect(
      bodyOf(
        "lyricsfile",
        "version: '1.0'\nmetadata: {title: a, artist: b}\nplain: |\n  Just text\n",
      ),
    ).toEqual({
      _tag: "Plain",
      text: "Just text",
    });
  });

  it("refuses unsafe or unknown YAML", () => {
    const bomb = [
      "version: '1.0'",
      "metadata: {title: a, artist: b}",
      "x1: &a [lol, lol, lol, lol, lol, lol, lol, lol, lol]",
      "x2: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "x3: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "x4: [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
    ].join("\n");

    expect(failureOf("lyricsfile", bomb)).toBe("malformed");
    expect(failureOf("lyricsfile", "version: '1.0'\nversion: '1.0'\nmetadata: {}\n")).toBe(
      "malformed",
    );
    expect(failureOf("lyricsfile", "version: '1.0'\nmetadata: !!js/function 'x'\n")).toBe(
      "malformed",
    );
    expect(failureOf("lyricsfile", `version: '1.0'\nmetadata: ${"[".repeat(5000)}`)).toBe(
      "malformed",
    );
    expect(failureOf("lyricsfile", "version: '2.0'\nmetadata: {}\nplain: hi\n")).toBe("malformed");
  });

  it("keeps lines that start together when their words or ends carry timing", () => {
    const together = [
      "version: '1.0'",
      "metadata: {title: a, artist: b}",
      "lines:",
      "  - {text: Lead, start_ms: 0, end_ms: 2000, words: [{text: 'Lead', start_ms: 1000, end_ms: 1500}]}",
      "  - {text: Echo, start_ms: 0, end_ms: 3000, words: [{text: 'Echo', start_ms: 1500, end_ms: 2500}]}",
    ].join("\n");

    const overlapping = [
      "version: '1.0'",
      "metadata: {title: a, artist: b}",
      "lines:",
      "  - {text: First, start_ms: 4000, end_ms: 6000}",
      "  - {text: Second, start_ms: 4000, end_ms: 8000}",
    ].join("\n");

    expect(bodyOf("lyricsfile", together)).toMatchObject({
      _tag: "Synced",
      lines: [
        { text: "Lead", startMs: 0, endMs: 2000, words: [{ startMs: 1000 }] },
        { text: "Echo", startMs: 0, endMs: 3000, words: [{ startMs: 1500 }] },
      ],
    });
    expect(bodyOf("lyricsfile", overlapping)).toMatchObject({
      _tag: "Synced",
      lines: [
        { text: "First", endMs: 6000 },
        { text: "Second", endMs: 8000 },
      ],
    });
  });

  it("drops an end before its start, and words that run backwards", () => {
    const text = [
      "version: '1.0'",
      "metadata: {title: a, artist: b}",
      "lines:",
      "  - {text: One, start_ms: 1000, end_ms: 500, words: [{text: 'One', start_ms: 1000, end_ms: 900}]}",
      "  - {text: Two three, start_ms: 2000, words: [{text: 'Two ', start_ms: 2500}, {text: three, start_ms: 2100}]}",
    ].join("\n");

    expect(bodyOf("lyricsfile", text)).toMatchObject({
      lines: [
        { text: "One", endMs: null, words: [{ text: "One", startMs: 1000, endMs: null }] },
        { text: "Two three", words: null },
      ],
    });
  });

  it("reads a version written as an unquoted number", () => {
    expect(
      bodyOf("lyricsfile", "version: 1.0\nmetadata: {title: a, artist: b}\nplain: Hi\n"),
    ).toEqual({
      _tag: "Plain",
      text: "Hi",
    });
  });

  it("has no lyrics when marked instrumental", () => {
    expect(failureOf("lyricsfile", "version: '1.0'\nmetadata: {instrumental: true}\n")).toBe(
      "empty",
    );
  });
});

describe("parseLyricsFile: times too large to represent", () => {
  const huge = "9".repeat(310);

  it.each([
    ["lrc", `[${huge}:01]Line`],
    ["lrc", `[00:01]<${huge}:01>Word`],
    ["lrc", `[offset:-${huge}]\n[00:01]Line\n[00:02]Next`],
    ["vtt", `WEBVTT\n\n${huge}:00:01.000 --> ${huge}:00:02.000\nLine`],
    ["srt", `1\n${huge}:00:01,000 --> ${huge}:00:02,000\nLine`],
    [
      "ttml",
      `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="${huge}s">Line</p></div></body></tt>`,
    ],
    [
      "ttml",
      `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="${huge}:00:01">Line</p></div></body></tt>`,
    ],
    [
      "lyricsfile",
      `version: '1.0'\nmetadata: {title: a, artist: b}\nlines:\n  - text: Line\n    start_ms: ${huge}\n`,
    ],
  ] satisfies ReadonlyArray<readonly [LyricsFormat, string]>)("fails for %s", (format, text) => {
    expect(failureOf(format, text)).toBe("malformed");
  });
});

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  contentTypeFor,
  extensionOf,
  isAudioFile,
  isBrowserPlayable,
  normalizeCodec,
} from "./audio-format.ts";

describe("extensionOf", () => {
  it("lowercases the last extension of the file name, ignoring dots in folders", () => {
    expect(extensionOf("Song.FLAC")).toBe("flac");
    expect(extensionOf("Artist/Album/01 Song.tar.mp3")).toBe("mp3");
    expect(extensionOf("Album v1.2/README")).toBe("");
    expect(extensionOf("no-extension")).toBe("");
    expect(extensionOf("trailing.")).toBe("");
  });

  it("finds any extension after any name, in any case", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[^./]{1,20}$/u),
        fc.stringMatching(/^[A-Za-z0-9]{1,5}$/u),
        (name, extension) => {
          expect(extensionOf(`${name}.${extension}`)).toBe(extension.toLowerCase());
        },
      ),
    );
  });
});

describe("isAudioFile", () => {
  it("accepts the library's audio extensions and nothing else", () => {
    for (const name of [
      "a.flac",
      "b.MP3",
      "c.m4a",
      "d.opus",
      "e.ogg",
      "f.wav",
      "g.aiff",
      "h.wma",
    ]) {
      expect(isAudioFile(name)).toBe(true);
    }

    for (const name of ["cover.jpg", "notes.txt", "video.mp4", "playlist.m3u", "flac"]) {
      expect(isAudioFile(name)).toBe(false);
    }
  });
});

describe("contentTypeFor", () => {
  it("names each audio type by extension and falls back to bytes", () => {
    expect(contentTypeFor("a.flac")).toBe("audio/flac");
    expect(contentTypeFor("a.mp3")).toBe("audio/mpeg");
    expect(contentTypeFor("a.m4a")).toBe("audio/mp4");
    expect(contentTypeFor("a.opus")).toBe("audio/ogg");
    expect(contentTypeFor("a.wav")).toBe("audio/wav");
    expect(contentTypeFor("a.unknown")).toBe("application/octet-stream");
  });
});

describe("normalizeCodec", () => {
  it("names the codec from the decoder's description", () => {
    expect(normalizeCodec("FLAC", "a.flac")).toBe("flac");
    expect(normalizeCodec("MPEG 1 Layer 3", "a.mp3")).toBe("mp3");
    expect(normalizeCodec("ALAC", "a.m4a")).toBe("alac");
    expect(normalizeCodec("AAC", "a.m4a")).toBe("aac");
    expect(normalizeCodec("MPEG-4/AAC", "a.m4a")).toBe("aac");
    expect(normalizeCodec("Opus", "a.opus")).toBe("opus");
    expect(normalizeCodec("Vorbis I", "a.ogg")).toBe("vorbis");
    expect(normalizeCodec("PCM", "a.wav")).toBe("pcm");
    expect(normalizeCodec("Windows Media Audio 9", "a.wma")).toBe("wma");
  });

  it("falls back to the extension, then to unknown", () => {
    expect(normalizeCodec(undefined, "a.ape")).toBe("ape");
    expect(normalizeCodec("Something New", "a.dsf")).toBe("dsf");
    expect(normalizeCodec(undefined, "noextension")).toBe("unknown");
  });
});

describe("isBrowserPlayable", () => {
  it("plays the codecs every browser decodes, except in containers browsers refuse", () => {
    expect(isBrowserPlayable("flac", "a.flac")).toBe(true);
    expect(isBrowserPlayable("mp3", "a.mp3")).toBe(true);
    expect(isBrowserPlayable("aac", "a.m4a")).toBe(true);
    expect(isBrowserPlayable("opus", "a.opus")).toBe(true);
    expect(isBrowserPlayable("pcm", "a.wav")).toBe(true);
    expect(isBrowserPlayable("pcm", "a.aiff")).toBe(false);
    expect(isBrowserPlayable("alac", "a.m4a")).toBe(false);
    expect(isBrowserPlayable("wma", "a.wma")).toBe(false);
  });
});

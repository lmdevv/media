import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { chooseStreamProfile, codecMimeType, parseStreamQuality } from "./stream-quality";

const everything = (): boolean => true;

const nothing = (): boolean => false;

describe("codecMimeType", () => {
  it.each([
    ["FLAC", "audio/flac"],
    ["MPEG 1 Layer 3", "audio/mpeg"],
    ["mp3", "audio/mpeg"],
    ["MPEG-4/AAC", 'audio/mp4; codecs="mp4a.40.2"'],
    ["ALAC", 'audio/mp4; codecs="alac"'],
    ["Opus", 'audio/ogg; codecs="opus"'],
    ["Vorbis I", 'audio/ogg; codecs="vorbis"'],
    ["PCM", "audio/wav"],
  ])("maps %s to %s", (codec, mimeType) => {
    expect(codecMimeType(codec)).toBe(mimeType);
  });

  it("returns null for codecs browsers do not play directly", () => {
    expect(codecMimeType("Windows Media Audio 9")).toBeNull();
    expect(codecMimeType("DSD")).toBeNull();
  });
});

describe("chooseStreamProfile", () => {
  it("plays the original for lossless when the browser can decode it", () => {
    expect(chooseStreamProfile("lossless", "FLAC", everything)).toBe("original");
  });

  it("transcodes lossless to AAC 320 when the browser cannot decode the codec", () => {
    expect(chooseStreamProfile("lossless", "ALAC", (type) => !type.includes("alac"))).toBe(
      "aac-320",
    );
    expect(chooseStreamProfile("lossless", "Windows Media Audio 9", everything)).toBe("aac-320");
  });

  it("high and data-saver ignore the codec and the browser", () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), (codec, playable) => {
        const canPlay = playable ? everything : nothing;

        expect(chooseStreamProfile("high", codec, canPlay)).toBe("aac-320");
        expect(chooseStreamProfile("data-saver", codec, canPlay)).toBe("aac-128");
      }),
    );
  });

  it("never asks for the original when the browser plays nothing", () => {
    fc.assert(
      fc.property(fc.string(), (codec) => {
        expect(chooseStreamProfile("lossless", codec, nothing)).toBe("aac-320");
      }),
    );
  });
});

describe("parseStreamQuality", () => {
  it("keeps known settings and defaults the rest to lossless", () => {
    expect(parseStreamQuality("data-saver")).toBe("data-saver");
    expect(parseStreamQuality("high")).toBe("high");
    expect(parseStreamQuality(null)).toBe("lossless");
    expect(parseStreamQuality("ultra")).toBe("lossless");
  });
});

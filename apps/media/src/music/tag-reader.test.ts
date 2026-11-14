import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isExplicit, readTrackTags } from "./tag-reader.ts";
import {
  makeDirectory,
  MEDIA_TEST_TIMEOUT,
  removeDirectory,
  writeSong,
} from "./testing/music-fixtures.ts";

let work = "";

beforeEach(async () => {
  work = await makeDirectory("tags");
});

afterEach(async () => {
  await removeDirectory(work);
});

describe("isExplicit", () => {
  it("reads iTunes' advisory from every tag format that carries it", () => {
    expect(isExplicit({ native: { iTunes: [{ id: "rtng", value: 1 }] } })).toBe(true);
    expect(isExplicit({ native: { iTunes: [{ id: "rtng", value: 4 }] } })).toBe(true);
    expect(isExplicit({ native: { iTunes: [{ id: "rtng", value: 2 }] } })).toBe(false);
    expect(isExplicit({ native: { iTunes: [{ id: "rtng", value: 0 }] } })).toBe(false);
    expect(
      isExplicit({
        native: { iTunes: [{ id: "----:com.apple.iTunes:ITUNESADVISORY", value: "1" }] },
      }),
    ).toBe(true);
    expect(isExplicit({ native: { vorbis: [{ id: "ITUNESADVISORY", value: "1" }] } })).toBe(true);
    expect(
      isExplicit({ native: { "ID3v2.4": [{ id: "TXXX:ITUNESADVISORY", value: ["1"] }] } }),
    ).toBe(true);
    expect(isExplicit({ native: { APEv2: [{ id: "ITUNESADVISORY", value: "2" }] } })).toBe(false);
    expect(isExplicit({ native: { vorbis: [{ id: "COMMENT", value: "1" }] } })).toBe(false);
    expect(isExplicit({ native: {} })).toBe(false);
  });
});

describe("readTrackTags", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("marks a song explicit only when its tags say so, in FLAC and in MP3", async () => {
    const cases = [
      ["explicit.flac", "1", true],
      ["clean.flac", "2", false],
      ["explicit.mp3", "1", true],
      ["untagged.mp3", null, false],
    ] as const;

    const read = await Promise.all(
      cases.map(async ([name, advisory]) => {
        const path = join(work, name);

        await writeSong(path, {
          seconds: 1,
          tags: advisory === null ? { title: name } : { title: name, ITUNESADVISORY: advisory },
        });

        const tags = await Effect.runPromise(readTrackTags(path));

        return { name, explicit: tags.explicit, title: tags.title };
      }),
    );

    expect(read).toEqual(cases.map(([name, , explicit]) => ({ name, explicit, title: name })));
  });
});

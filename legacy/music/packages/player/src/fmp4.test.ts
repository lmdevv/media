import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fragmentedArgs } from "@music/media/ffmpeg";
import * as fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";

import { HeaderRead, readHeader } from "./fmp4";
import type { StreamHeader } from "./fmp4";

const encoder = new TextEncoder();

/** One MP4 box with a 32-bit size. */
const box = (type: string, ...payload: ReadonlyArray<Uint8Array>): Uint8Array => {
  const size = 8 + payload.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set(encoder.encode(type), 4);
  let at = 8;

  for (const part of payload) {
    bytes.set(part, at);
    at += part.length;
  }

  return bytes;
};

const u32 = (...values: ReadonlyArray<number>): Uint8Array => {
  const bytes = new Uint8Array(values.length * 4);
  const data = new DataView(bytes.buffer);

  for (const [index, value] of values.entries()) data.setUint32(index * 4, value);

  return bytes;
};

/** A moov whose first sample entry has type `entry`. */
const moov = (entry: string): Uint8Array =>
  box(
    "moov",
    box(
      "trak",
      box("mdia", box("minf", box("stbl", box("stsd", u32(0, 1), box(entry, new Uint8Array(28)))))),
    ),
  );

interface Reference {
  readonly size: number;
  readonly duration: number;
}

/** A version 0 sidx with `references`, starting `firstOffset` bytes after itself. */
const sidx = (
  timescale: number,
  earliest: number,
  firstOffset: number,
  references: ReadonlyArray<Reference>,
): Uint8Array => {
  const head = u32(0, 1, timescale, earliest, firstOffset);
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint16(2, references.length);
  const body = references.map(({ size, duration }) => u32(size, duration, 0x90_00_00_00));

  return box("sidx", head, count, ...body);
};

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;

  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }

  return bytes;
};

const readBoxType = (bytes: Uint8Array, at: number): string =>
  String.fromCodePoint(...bytes.subarray(at + 4, at + 8));

const complete = (read: HeaderRead): StreamHeader | null =>
  HeaderRead.$is("Complete")(read) ? read.header : null;

const ftyp = box("ftyp", encoder.encode("isom"), u32(512));

const moofHeader = box("moof", new Uint8Array(16));

describe("readHeader", () => {
  it("reads the codec, the init segment, and absolute fragment offsets", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(["fLaC", "flac"] as const, ["mp4a", "aac"] as const),
        fc.integer({ min: 8000, max: 192_000 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.array(
          fc.record({
            size: fc.integer({ min: 16, max: 2_000_000 }),
            duration: fc.integer({ min: 1, max: 200_000 }),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        ([entry, codec], timescale, earliest, references) => {
          const init = concat(ftyp, moov(entry));
          const index = sidx(timescale, earliest, 0, references);
          const header = complete(readHeader(concat(init, index, moofHeader)));

          expect(header?.codec).toBe(codec);
          expect(header?.init).toEqual(init);
          expect(header?.length).toBe(init.length + index.length);
          expect(header?.index?.timescale).toBe(timescale);

          let offset = init.length + index.length;
          let time = earliest;

          for (const [position, reference] of references.entries()) {
            expect(header?.index?.fragments[position]).toEqual({
              offset,
              size: reference.size,
              time,
              duration: reference.duration,
            });
            offset += reference.size;
            time += reference.duration;
          }
        },
      ),
    );
  });

  it("waits for more bytes until the first moof header is in view", () => {
    const stream = concat(ftyp, moov("fLaC"), sidx(48_000, 0, 0, [{ size: 24, duration: 1 }]));
    const full = concat(stream, moofHeader);

    for (let length = 0; length < stream.length + 8; length += 1) {
      expect(readHeader(full.subarray(0, length))).toEqual(HeaderRead.Incomplete());
    }

    expect(complete(readHeader(full))?.codec).toBe("flac");
  });

  it("accepts a stream without an index", () => {
    const header = complete(readHeader(concat(ftyp, moov("mp4a"), moofHeader)));

    expect(header?.index).toBeNull();
  });

  it("rejects streams it cannot play", () => {
    expect(HeaderRead.$is("Invalid")(readHeader(concat(ftyp, moofHeader)))).toBe(true);
    expect(HeaderRead.$is("Invalid")(readHeader(concat(ftyp, moov("Opus"), moofHeader)))).toBe(
      true,
    );
    expect(HeaderRead.$is("Invalid")(readHeader(concat(u32(4, 0x66_74_79_70))))).toBe(true);
  });
});

describe("readHeader on the media service's real output", () => {
  const dir = mkdtempSync(join(tmpdir(), "music-fmp4-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const profile of ["fmp4-flac", "fmp4-aac"] as const) {
    it(`indexes every fragment of ${profile}`, () => {
      const source = join(dir, "tone.flac");
      const output = join(dir, `${profile}.m4a`);

      execFileSync("ffmpeg", [
        "-hide_banner",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=330:sample_rate=48000:duration=4.3",
        "-c:a",
        "flac",
        source,
      ]);
      execFileSync("ffmpeg", fragmentedArgs(source, output, profile, "flac", 48_000), {
        stdio: ["ignore", "ignore", "inherit"],
      });

      const bytes = new Uint8Array(readFileSync(output));
      const header = complete(readHeader(bytes));
      const fragments = header?.index?.fragments ?? [];
      const last = fragments.at(-1);

      expect(header?.codec).toBe(profile === "fmp4-flac" ? "flac" : "aac");
      expect(fragments.length).toBeGreaterThanOrEqual(4);

      // Every indexed offset lands on a moof, and the fragments cover the whole file.
      for (const fragment of fragments) {
        expect(readBoxType(bytes, fragment.offset)).toBe("moof");
      }

      // The fragments run to the end of the file, apart from ffmpeg's trailing `mfra` index.
      const end = (last?.offset ?? 0) + (last?.size ?? 0);

      expect(end === bytes.length || readBoxType(bytes, end) === "mfra").toBe(true);
      expect(fragments[0]?.offset).toBe(header?.length);
    });
  }
});

import * as fc from "fast-check";
import { Exit, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  NegotiateResponse,
  PlaybackApiError,
  SeekResponse,
  type TranscodeChange,
  type TranscodeFailed,
  TranscodeReason,
  type TranscodeStage,
  TranscodeSummary,
} from "./media-playback";
import { EpochMillis } from "./units";

/** `value` as the wire carries it and read back. */
const overTheWire = <A, I>(schema: Schema.Codec<A, I>, value: A): A => {
  const codec = Schema.toCodecJson(schema);

  return Schema.decodeUnknownSync(codec)(
    JSON.parse(JSON.stringify(Schema.encodeSync(codec)(value))),
  );
};

const stage: fc.Arbitrary<TranscodeStage> = fc.oneof(
  fc.record({ op: fc.string(), domain: fc.string(), impl: fc.string() }),
  fc.record({
    op: fc.constant("move"),
    domain: fc.string(),
    impl: fc.string(),
    move: fc.record({ from: fc.string(), to: fc.string() }),
  }),
);

const summary = fc.record({
  stages: fc.array(stage, { maxLength: 8 }),
  changes: fc.array(
    fc.record({
      at: fc.integer({ min: 0, max: 8_640_000_000_000_000 }).map((at) => EpochMillis.make(at)),
      generation: fc.integer({ min: 1, max: 1000 }),
      cause: fc.string(),
      excluded: fc.array(fc.string(), { maxLength: 4 }),
      reason: fc.constantFrom(...TranscodeReason.literals),
    }),
    { maxLength: 3 },
  ),
});

const video = { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" } as const;

const STREAM_ID = "stream-0123456789abcde";

describe("TranscodeSummary", () => {
  it("comes back over the wire as it went, moves and changes included", () => {
    fc.assert(
      fc.property(summary, (value) => {
        expect(overTheWire(TranscodeSummary, value)).toEqual(value);
      }),
    );
  });

  it("takes an operation, domain, or cause no client knows yet", () => {
    expect(
      Schema.decodeSync(TranscodeSummary)({
        stages: [{ op: "denoise", domain: "nvenc", impl: "denoise.nvenc" }],
        changes: [
          {
            at: 1,
            generation: 2,
            cause: "driver-crash",
            excluded: ["encode.nvenc"],
            reason: "other",
          },
        ],
      }).stages[0]?.domain,
    ).toBe("nvenc");
  });
});

/** A reason code a newer server added, which this client's list lacks. */
const NEWER = "driver-reset";

/** A transcode whose one change gives `reason`. */
const transcodeGiving = (reason: string) => ({
  stages: [{ op: "encode", domain: "cpu", impl: "encode.cpu" }],
  changes: [{ at: 1, generation: 2, cause: "source", excluded: ["encode.qsv"], reason }],
});

/** `json` read the way a client reads the media service's answer. */
const readAnswer = <A, I>(schema: Schema.Codec<A, I>, json: Schema.Json) =>
  Schema.decodeExit(Schema.toCodecJson(schema))(json);

describe("reasons", () => {
  it("decode a code a newer server added in a negotiation, a seek, or a failure, and keep the rest", () => {
    const negotiated = {
      mode: "transcode-software",
      url: `http://media.test/media/hls/${STREAM_ID}/2/index.m3u8`,
      streamId: STREAM_ID,
      generation: 2,
      startSeconds: 0,
      durationSeconds: 60,
      video,
      transcode: transcodeGiving(NEWER),
      subtitles: [],
      expiresAt: 1,
    };

    const seek = {
      streamId: STREAM_ID,
      generation: 2,
      playlistUrl: `http://media.test/media/hls/${STREAM_ID}/2/index.m3u8`,
      mode: "transcode-software",
      video,
      transcode: transcodeGiving(NEWER),
    };

    const failed = {
      _tag: "TranscodeFailed",
      streamId: STREAM_ID,
      mode: "transcode-qsv",
      reason: NEWER,
    };

    expect(readAnswer(NegotiateResponse, negotiated)).toStrictEqual(Exit.succeed(negotiated));
    expect(readAnswer(SeekResponse, seek)).toStrictEqual(Exit.succeed(seek));

    const failure = readAnswer(PlaybackApiError, failed);

    expect(Exit.isSuccess(failure) ? failure.value : failure).toMatchObject(failed);
    expect(Exit.isSuccess(failure) ? failure.value.message : null).toBe(
      `Transcode failed in transcode-qsv: ${NEWER}`,
    );
  });

  it("come back over the wire as they went, a known code as the code itself", () => {
    for (const reason of [...TranscodeReason.literals, NEWER]) {
      const decoded = Schema.decodeSync(TranscodeSummary)(transcodeGiving(reason));

      expect(overTheWire(TranscodeSummary, decoded)).toEqual(decoded);
      expect(decoded.changes[0]?.reason).toBe(reason);
      expect(Schema.is(TranscodeReason)(decoded.changes[0]?.reason)).toBe(reason !== NEWER);
    }
  });

  it("admit only the closed list where the service builds a change or a failure", () => {
    expectTypeOf<TranscodeReason>().toExtend<TranscodeChange["reason"]>();
    expectTypeOf<TranscodeReason>().toExtend<TranscodeFailed["reason"]>();
    expectTypeOf<typeof NEWER>().not.toExtend<TranscodeChange["reason"]>();
    expectTypeOf<string>().not.toExtend<TranscodeFailed["reason"]>();
  });
});

describe("the responses that name a generation", () => {
  it("carry the generation's summary, mode, and picture on a seek, and come back as they went", () => {
    fc.assert(
      fc.property(summary, fc.integer({ min: 1, max: 1000 }), (transcode, generation) => {
        const seek = Schema.decodeSync(SeekResponse)({
          streamId: STREAM_ID,
          generation,
          playlistUrl: `http://media.test/media/hls/${STREAM_ID}/${String(generation)}/index.m3u8`,
          mode: "transcode-software",
          video,
          transcode,
        });

        expect(overTheWire(SeekResponse, seek)).toEqual(seek);
      }),
    );
  });

  it("refuses a seek answer without its summary, and takes a direct negotiation without one", () => {
    const decodeSeek = Schema.decodeUnknownExit(SeekResponse);

    expect(
      Exit.isFailure(
        decodeSeek({
          streamId: STREAM_ID,
          generation: 2,
          playlistUrl: "http://media.test/x.m3u8",
          mode: "remux",
          video,
        }),
      ),
    ).toBe(true);

    const direct = Schema.decodeSync(NegotiateResponse)({
      mode: "direct",
      url: "http://media.test/media/direct/f",
      startSeconds: 0,
      durationSeconds: 60,
      video,
      subtitles: [],
      expiresAt: 1,
    });

    expect(direct.transcode).toBeUndefined();
  });
});

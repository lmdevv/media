import { assert, describe, it } from "@effect/vitest";
import { Result, Schema } from "effect";

import {
  advance,
  Attribution,
  attribute,
  Diagnosis,
  fresh,
  type LogOwners,
  Recovery,
  type RecoveryState,
} from "./transcode-recovery.ts";
import {
  assemble,
  candidateKeys,
  type CapabilitySnapshot,
  Purpose,
  rowOf,
  type VideoPipeline,
} from "./video-pipeline.ts";
import { ImplId, Op, type Row, type SourceVideo } from "./video-ops.ts";

const HDR: SourceVideo = {
  codec: "hevc",
  pixelFormat: "yuv420p10le",
  depth: 10,
  colour: "hdr10",
  scan: "progressive",
  width: 1920,
  height: 1080,
};

const row = (id: string): Row => {
  const found = rowOf(ImplId(id));

  if (found === undefined) throw new Error(`no row ${id}`);

  return found;
};

const everything = (domain: "qsv" | "vaapi"): CapabilitySnapshot => {
  const bound = {
    domains: [{ domain, device: "/dev/dri/renderD128" }],
    verified: new Set<never>(),
    excluded: new Set<never>(),
  };

  const keys = candidateKeys(
    HDR,
    {
      codec: "h264",
      toneMap: true,
      bounds: { width: 1920, height: 1080 },
      cpuEncodeBounds: { width: 1920, height: 1080 },
      maxBitrate: undefined,
      burnImage: undefined,
    },
    bound,
  );

  return { ...bound, verified: new Set(keys.keys()) };
};

const chain = (
  domain: "qsv" | "vaapi",
  rows: ReadonlyArray<readonly [Op, string]>,
  source: SourceVideo = HDR,
): VideoPipeline => {
  const built = assemble(
    source,
    rows.map(([op, id]) => [op, row(id)] as const),
    everything(domain),
    Purpose.Run(),
  );

  if (Result.isFailure(built)) throw new Error(JSON.stringify(built.failure));

  return built.success;
};

/** decode.qsv, scale.qsv + tonemap.qsv fused into Parsed_vpp_qsv_0, encode.qsv. */
const QSV_CHAIN = chain("qsv", [
  [Op.Decode({ codec: "hevc" }), "decode.qsv"],
  [Op.Scale({ width: 1280, height: 720, depth: 10 }), "scale.qsv"],
  [Op.ToneMap(), "tonemap.qsv"],
  [Op.Encode({ codec: "h264", bitrate: 8_000_000 }), "encode.qsv"],
]);

const QSV_OWNERS: LogOwners = {
  decoder: { step: 0, names: ["hevc", "hevc_qsv"] },
  encoder: { step: 3, names: ["h264_qsv"] },
  filters: new Map([["Parsed_vpp_qsv_0", [1, 2]]]),
};

/** decode.vaapi, scale_vaapi (Parsed_scale_vaapi_0), tonemap_vaapi (Parsed_tonemap_vaapi_1), encode. */
const VAAPI_CHAIN = chain("vaapi", [
  [Op.Decode({ codec: "hevc" }), "decode.vaapi"],
  [Op.Scale({ width: 1280, height: 720, depth: 10 }), "scale.vaapi"],
  [Op.ToneMap(), "tonemap.vaapi"],
  [Op.Encode({ codec: "h264", bitrate: 8_000_000 }), "encode.vaapi"],
]);

const VAAPI_OWNERS: LogOwners = {
  decoder: { step: 0, names: ["hevc"] },
  encoder: { step: 3, names: ["h264_vaapi"] },
  filters: new Map([
    ["Parsed_scale_vaapi_0", [1]],
    ["Parsed_tonemap_vaapi_1", [2]],
  ]),
};

/** decode.cpu, upload (Parsed_format_0, Parsed_hwupload_1), scale_vaapi (Parsed_scale_vaapi_2), encode. */
const UPLOAD_CHAIN = chain(
  "vaapi",
  [
    [Op.Decode({ codec: "hevc" }), "decode.cpu"],
    [Op.Scale({ width: 1280, height: 720, depth: 8 }), "scale.vaapi"],
    [Op.Encode({ codec: "h264", bitrate: 8_000_000 }), "encode.vaapi"],
  ],
  { ...HDR, colour: "sdr" },
);

const UPLOAD_OWNERS: LogOwners = {
  decoder: { step: 0, names: ["hevc"] },
  encoder: { step: 3, names: ["h264_vaapi"] },
  filters: new Map([
    ["Parsed_format_0", [1]],
    ["Parsed_hwupload_1", [1]],
    ["Parsed_scale_vaapi_2", [2]],
  ]),
};

const failed = (
  stderrTail: string,
  exitCode: number | null = 234,
  signal: string | null = null,
) => ({
  exitCode,
  signal,
  stderrTail,
});

const suspects = (attribution: Attribution): ReadonlyArray<number> | string =>
  Attribution.$match(attribution, {
    NotVideo: ({ reason }) => reason,
    Video: ({ suspects: steps }) => steps,
  });

/** Heads of standard error captured on the Arc A380 with ffmpeg 9.0.2. */
const HEADS = {
  qsvDecoder: [
    "[h264_qsv @ 0x62a4887c4500] Error querying IO surface: unsupported (-3)",
    "[vist#0:0/h264 @ 0x62a4888f00c0] [dec:h264_qsv @ 0x62a4887b4fc0] Error submitting packet to decoder: Function not implemented",
  ],
  vaapiDecoder: [
    "[h264 @ 0x63531be9ce00] Failed setup for format vaapi: hwaccel initialisation returned error.",
    "Impossible to convert between the formats supported by the filter 'graph -1 input from stream 0:0' and the filter 'auto_scale_0'",
  ],
  toneMap: [
    "[Parsed_tonemap_vaapi_1 @ 0x7398f8005480] No mastering display data from input",
    "[vf#0:0 @ 0x566ff4ef0680] Error while filtering: Invalid argument",
    "[vost#0:0/h264_vaapi @ 0x566ff4ef6cc0] [enc:h264_vaapi @ 0x566ff4e6c380] Could not open encoder before EOF",
  ],
  fused: [
    "[Parsed_vpp_qsv_0 @ 0x586af22e5ac0] Invalid color_matrix.",
    "[AVFilterGraph @ 0x586af23d82c0] Error initializing filters",
  ],
  download: [
    "[hwdownload @ 0x7fd938003f00] Invalid output format nv12 for hwframe download.",
    "[Parsed_hwupload_1 @ 0x7fd938003e00] Failed to configure output pad on Parsed_hwupload_1",
  ],
  encoder: [
    "[h264_vaapi @ 0x55ad7c077300] No usable encoding profile found.",
    "[vost#0:0/h264_vaapi @ 0x55ad7c07dac0] [enc:h264_vaapi @ 0x55ad7bff5f00] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.",
  ],
  device: [
    "[VAAPI @ 0x5a4228175300] No VA display found for device <path>.",
    "Device creation failed: -22.",
    "Failed to set value 'qsv=hw,child_device=<path>' for option 'init_hw_device': Invalid argument",
  ],
  audio: [
    "[aac_adtstoasc @ 0x5f1fe8636cc0] Codec 'ac3' (86019) is not supported by the bitstream filter 'aac_adtstoasc'. Supported codecs are: aac (86018) ",
    "[aost#0:1/copy @ 0x5f1fe88a2d80] Error initializing bitstream filter: aac_adtstoasc",
  ],
  mux: [
    "[hls @ 0x6477b151ffc0] Failed to open segment 'init.mp4'",
    "[out#0/hls @ 0x6477b151fec0] Could not write header (incorrect codec parameters ?): No such file or directory",
  ],
  input: [
    "[in#0 @ 0x56b3de574080] Error opening input: No such file or directory",
    "Error opening input file <path>.",
  ],
  disk: ["[hls @ 0x6477b151ffc0] Failed to write segment: No space left on device"],
  /** What ffmpeg writes after a stream's own failure, whatever failed. */
  aftermath: [
    "[vf#0:0 @ 0x566ff4ef0680] Task finished with error code: -22 (Invalid argument)",
    "[aost#0:1/aac @ 0x566ff4ef7cc0] Terminating thread with return code -32 (Broken pipe)",
    "[out#0/hls @ 0x566ff4ef5ec0] Nothing was written into output file, because at least one of its streams received no packets.",
    "Conversion failed!",
  ],
} as const;

/** A decode error H.264 recovers from, logged as the run goes on. */
const RECOVERED_DECODE = "[h264 @ 0x5d1c2a0] error while decoding MB 45 30, bytestream -7";

/** Lines that say a part other than the video failed, each a failure of its own. */
const NOT_VIDEO = [
  ["disk", "[out#0/hls @ 0x6477b151fec0] Error writing trailer: No space left on device"],
  ["disk", "[hls @ 0x6477b151ffc0] Failed to write segment: Disk quota exceeded"],
  ["mux", "[hls @ 0x6477b151ffc0] Failed to open segment 'f3.m4s'"],
  ["input", "[in#0/matroska,webm @ 0x56b3de574080] Error during demuxing: Input/output error"],
  ["audio", "[aost#0:1/aac @ 0x5f1fe88a2d80] Error while opening encoder"],
  ["stopped", "Exiting normally, received signal 15."],
] as const;

/** Warnings about parts other than the video that a run goes on past, captured as ffmpeg writes them. */
const RECOVERED = [
  "[aist#0:1/ac3 @ 0x5f1fe88a2d80] [dec:ac3 @ 0x5f1fe8636cc0] Error submitting packet to decoder: Invalid data found when processing input",
  "[mpegts @ 0x5f2c3a0c] Packet corrupt (stream = 1, dts = 1234567).",
  RECOVERED_DECODE,
] as const;

/** Heads of a video failure, and the steps of `QSV_CHAIN` each names. */
const VIDEO_FAILURES = {
  fused: [1, 2],
  encoder: [3],
  qsvDecoder: [0],
  device: [0, 1, 2, 3],
} as const;

describe("attribute", () => {
  it("names the decoder, a filter, a fused filter's steps, and the encoder", () => {
    const qsvDecode = chain(
      "qsv",
      [
        [Op.Decode({ codec: "hevc" }), "decode.qsv"],
        [Op.Scale({ width: 1280, height: 720, depth: 8 }), "scale.qsv"],
        [Op.Encode({ codec: "h264", bitrate: 8_000_000 }), "encode.qsv"],
      ],
      { ...HDR, colour: "sdr" },
    );

    assert.deepStrictEqual(
      suspects(
        attribute(
          qsvDecode,
          {
            ...QSV_OWNERS,
            decoder: { step: 0, names: ["h264", "h264_qsv"] },
            encoder: { step: 2, names: ["libx264"] },
          },
          failed(HEADS.qsvDecoder.join("\n"), 69),
        ),
      ),
      [0],
    );
    assert.deepStrictEqual(
      suspects(
        attribute(
          VAAPI_CHAIN,
          { ...VAAPI_OWNERS, decoder: { step: 0, names: ["h264"] } },
          failed(HEADS.vaapiDecoder.join("\n"), 218),
        ),
      ),
      [0],
    );
    assert.deepStrictEqual(
      suspects(attribute(VAAPI_CHAIN, VAAPI_OWNERS, failed(HEADS.toneMap.join("\n")))),
      [2],
    );
    assert.deepStrictEqual(
      suspects(attribute(QSV_CHAIN, QSV_OWNERS, failed(HEADS.fused.join("\n")))),
      [1, 2],
    );
    assert.deepStrictEqual(
      suspects(attribute(VAAPI_CHAIN, VAAPI_OWNERS, failed(HEADS.encoder.join("\n"), 218))),
      [3],
    );
  });

  it("reads past a tag the run does not own, and a filter name of another graph, to a line that names a step", () => {
    assert.deepStrictEqual(
      suspects(
        attribute(
          VAAPI_CHAIN,
          VAAPI_OWNERS,
          failed(["[Parsed_vpp_qsv_7 @ 0x1] Not this run's.", ...HEADS.toneMap].join("\n")),
        ),
      ),
      [2],
    );
    assert.strictEqual(
      suspects(
        attribute(VAAPI_CHAIN, VAAPI_OWNERS, failed("[Parsed_aresample_1 @ 0x1] Invalid argument")),
      ),
      "audio",
    );
    assert.deepStrictEqual(
      suspects(attribute(UPLOAD_CHAIN, UPLOAD_OWNERS, failed(HEADS.download.join("\n")))),
      [1],
    );
  });

  it("suspects every step on the device when the device would not open", () => {
    assert.deepStrictEqual(
      suspects(attribute(QSV_CHAIN, QSV_OWNERS, failed(HEADS.device.join("\n")))),
      [0, 1, 2, 3],
    );
  });

  it("debits no video capability for audio, the muxer, the input, the disk, a stop, or a run that never started", () => {
    assert.strictEqual(
      suspects(attribute(QSV_CHAIN, QSV_OWNERS, failed(HEADS.audio.join("\n")))),
      "audio",
    );
    assert.strictEqual(
      suspects(attribute(QSV_CHAIN, QSV_OWNERS, failed(HEADS.mux.join("\n"), 254))),
      "mux",
    );
    assert.strictEqual(
      suspects(attribute(QSV_CHAIN, QSV_OWNERS, failed(HEADS.input.join("\n"), 254))),
      "input",
    );
    assert.strictEqual(
      suspects(attribute(QSV_CHAIN, QSV_OWNERS, failed(HEADS.disk.join("\n"), 1))),
      "disk",
    );
    assert.strictEqual(
      suspects(attribute(QSV_CHAIN, QSV_OWNERS, failed("", null, "SIGKILL"))),
      "stopped",
    );
    assert.strictEqual(suspects(attribute(QSV_CHAIN, QSV_OWNERS, failed("", null, null))), "spawn");
  });

  it("classifies by the line that ended the run, past warnings the run went on past", () => {
    // A decode error the run recovered from, then the muxer meets a full disk.
    assert.deepStrictEqual(
      attribute(
        QSV_CHAIN,
        { ...QSV_OWNERS, decoder: { step: 0, names: ["h264", "h264_qsv"] } },
        failed([RECOVERED_DECODE, HEADS.disk[0]].join("\n"), 1),
      ),
      Attribution.NotVideo({ reason: "disk" }),
    );

    // An audio packet the run dropped, then the encoder fails: the encoder is named.
    assert.deepStrictEqual(
      attribute(
        QSV_CHAIN,
        QSV_OWNERS,
        failed(
          [
            RECOVERED[0],
            "[h264_qsv @ 0x5d1c2a0] Error during encoding: device failed (-17)",
            "[vost#0:0/h264_qsv @ 0x5d1c3b0] [enc:h264_qsv @ 0x5d1c2a0] Error submitting video frame to the encoder",
            ...HEADS.aftermath,
          ].join("\n"),
        ),
      ),
      Attribution.Video({ named: true, suspects: [3] }),
    );

    // A corrupt container packet the demuxer skipped, then the fused vpp_qsv fails.
    assert.deepStrictEqual(
      suspects(attribute(QSV_CHAIN, QSV_OWNERS, failed([RECOVERED[1], ...HEADS.fused].join("\n")))),
      [1, 2],
    );

    for (const [reason, line] of NOT_VIDEO) {
      assert.strictEqual(
        suspects(attribute(QSV_CHAIN, QSV_OWNERS, failed([...HEADS.fused, line].join("\n")))),
        reason,
        line,
      );
    }
  });

  it("reads past what ffmpeg writes after any failure to the part that failed", () => {
    assert.deepStrictEqual(
      suspects(
        attribute(
          VAAPI_CHAIN,
          VAAPI_OWNERS,
          failed([...HEADS.encoder, ...HEADS.aftermath].join("\n"), 218),
        ),
      ),
      [3],
    );
    assert.deepStrictEqual(
      suspects(
        attribute(QSV_CHAIN, QSV_OWNERS, failed([...HEADS.fused, ...HEADS.aftermath].join("\n"))),
      ),
      [1, 2],
    );
  });

  it.prop(
    "never suspects a video step when the run ended on a line that says another part failed",
    {
      before: Schema.Array(
        Schema.Literals(["fused", "encoder", "qsvDecoder", "device", "aftermath"]),
      ),
      aftermath: Schema.Boolean,
      cause: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: NOT_VIDEO.length - 1 })),
    },
    ({ before, aftermath, cause }) => {
      const [reason, line] = NOT_VIDEO[cause] ?? NOT_VIDEO[0];

      const tail = [
        ...before.flatMap((name) => HEADS[name]),
        line,
        ...(aftermath ? HEADS.aftermath : []),
      ].join("\n");

      assert.deepStrictEqual(
        attribute(QSV_CHAIN, QSV_OWNERS, failed(tail)),
        Attribution.NotVideo({ reason }),
      );
    },
  );

  it.prop(
    "names the video part that ended the run, whatever warnings came before it",
    {
      warnings: Schema.Array(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: RECOVERED.length - 1 })),
      ),
      failure: Schema.Literals(["fused", "encoder", "qsvDecoder", "device"]),
      aftermath: Schema.Boolean,
    },
    ({ warnings, failure, aftermath }) => {
      const tail = [
        ...warnings.map((index) => RECOVERED[index] ?? RECOVERED_DECODE),
        ...HEADS[failure],
        ...(aftermath ? HEADS.aftermath : []),
      ].join("\n");

      assert.deepStrictEqual(
        attribute(QSV_CHAIN, QSV_OWNERS, failed(tail)),
        Attribution.Video({ named: true, suspects: [...VIDEO_FAILURES[failure]] }),
      );
    },
  );

  it("suspects every GPU step of a crash that named nothing", () => {
    assert.deepStrictEqual(
      attribute(UPLOAD_CHAIN, UPLOAD_OWNERS, failed("", null, "SIGSEGV")),
      Attribution.Video({ named: false, suspects: [1, 2, 3] }),
    );
  });
});

const AnyDiagnosis = Schema.Literals([
  "Capability",
  "Source",
  "Undecided",
  "NotVideo",
  "Unexplained",
]);

const diagnosisOf = (name: typeof AnyDiagnosis.Type, impl: ImplId): Diagnosis => {
  const diagnoses: Readonly<Record<typeof AnyDiagnosis.Type, Diagnosis>> = {
    Capability: Diagnosis.Capability({ keys: [], impls: [impl] }),
    Source: Diagnosis.Source({ impls: [impl] }),
    Undecided: Diagnosis.Undecided({ impls: [impl] }),
    NotVideo: Diagnosis.NotVideo({ reason: "audio" }),
    Unexplained: Diagnosis.Unexplained(),
  };

  return diagnoses[name];
};

describe("advance", () => {
  it.prop(
    "ends within three runs, and exclusions only grow",
    {
      diagnoses: Schema.Array(AnyDiagnosis),
      steps: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
    },
    ({ diagnoses, steps }) => {
      let state: RecoveryState = fresh;
      let runs = 1;

      for (const [index, name] of diagnoses.entries()) {
        const impl = QSV_CHAIN.steps[steps[index] ?? 0]?.impl ?? ImplId("decode.qsv");
        const next = advance(state, diagnosisOf(name, impl), QSV_CHAIN);

        if (Recovery.$is("GiveUp")(next)) break;

        for (const excluded of state.excluded) assert.isTrue(next.state.excluded.has(excluded));
        state = next.state;
        runs += 1;
      }

      assert.isAtMost(runs, 3);
    },
  );

  it("replans without the suspect first, then without every GPU row, then gives up", () => {
    const first = advance(
      fresh,
      Diagnosis.Capability({ keys: [], impls: [ImplId("tonemap.qsv")] }),
      QSV_CHAIN,
    );

    assert.isTrue(Recovery.$is("Replan")(first));

    if (!Recovery.$is("Replan")(first)) return;
    assert.deepStrictEqual([...first.state.excluded], [ImplId("tonemap.qsv")]);

    const second = advance(
      first.state,
      Diagnosis.Source({ impls: [ImplId("encode.qsv")] }),
      QSV_CHAIN,
    );

    assert.isTrue(Recovery.$is("Replan")(second));

    if (!Recovery.$is("Replan")(second)) return;
    assert.isTrue(second.state.excluded.has(ImplId("decode.vaapi")));
    assert.isFalse(second.state.excluded.has(ImplId("encode.cpu")));
    assert.isTrue(
      Recovery.$is("GiveUp")(advance(second.state, Diagnosis.Unexplained(), QSV_CHAIN)),
    );
  });

  it("goes to the CPU at once for a failure that points at nothing, and gives up on the CPU", () => {
    const cpu = chain("qsv", [
      [Op.Decode({ codec: "hevc" }), "decode.cpu"],
      [Op.Scale({ width: 1280, height: 720, depth: 10 }), "scale.cpu"],
      [Op.ToneMap(), "tonemap.cpu"],
      [Op.Encode({ codec: "h264", bitrate: 8_000_000 }), "encode.cpu"],
    ]);

    assert.isTrue(
      Recovery.$is("Replan")(advance(fresh, Diagnosis.NotVideo({ reason: "audio" }), QSV_CHAIN)),
    );
    assert.isTrue(Recovery.$is("GiveUp")(advance(fresh, Diagnosis.Unexplained(), cpu)));
    assert.isTrue(
      Recovery.$is("GiveUp")(advance(fresh, Diagnosis.NotVideo({ reason: "spawn" }), QSV_CHAIN)),
    );
  });
});

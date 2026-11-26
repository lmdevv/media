import { assert, describe, it } from "@effect/vitest";
import { Result, Schema } from "effect";

import {
  assemble,
  candidateKeys,
  type CapabilitySnapshot,
  type DomainBinding,
  planVideo,
  probedSteps,
  probeFor,
  Purpose,
  Rejection,
  rowOf,
  rowsOf,
  sourceProbeFor,
  type VideoIntent,
  type VideoPipeline,
  VIDEO_OPS,
} from "./video-pipeline.ts";
import { renderVideo } from "./video-render.ts";
import {
  type CapabilityKey,
  capabilityKey,
  ImplId,
  implOf,
  Op,
  type OutputTarget,
  type Row,
  sdrTarget,
  type SourceVideo,
} from "./video-ops.ts";

const QSV: DomainBinding = { domain: "qsv", device: "/dev/dri/renderD128" };

const VAAPI: DomainBinding = { domain: "vaapi", device: "/dev/dri/renderD128" };

const source = (overrides: Partial<SourceVideo> = {}): SourceVideo => ({
  codec: "h264",
  pixelFormat: "yuv420p",
  depth: 8,
  colour: "sdr",
  scan: "progressive",
  width: 1920,
  height: 1080,
  ...overrides,
});

const intentFor = (video: SourceVideo, overrides: Partial<VideoIntent> = {}): VideoIntent => ({
  targets: [sdrTarget("h264")],
  bounds: { width: 3840, height: 2160 },
  cpuEncodeBounds: { width: 1920, height: 1080 },
  maxBitrate: undefined,
  burnImage: undefined,
  ...overrides,
});

const subtitle = {
  input: 0,
  stream: 3,
  codec: "dvd_subtitle",
  frame: {
    memory: "cpu" as const,
    device: undefined,
    colour: "sdr" as const,
    depth: 8,
    pixelFormat: "pal8",
    scan: "progressive" as const,
    width: 720,
    height: 576,
  },
};

const snapshot = (
  domains: ReadonlyArray<DomainBinding>,
  verified: Iterable<CapabilityKey>,
  excluded: Iterable<ImplId> = [],
): CapabilitySnapshot => ({ domains, verified: new Set(verified), excluded: new Set(excluded) });

/** Every key some chain for the source could use, on `domains`. */
const everyKey = (
  video: SourceVideo,
  intent: VideoIntent,
  domains: ReadonlyArray<DomainBinding>,
): ReadonlyArray<CapabilityKey> => [...candidateKeys(video, intent, snapshot(domains, [])).keys()];

const row = (id: string): Row => {
  const found = rowOf(ImplId(id));

  if (found === undefined) throw new Error(`no row ${id}`);

  return found;
};

const impls = (pipeline: VideoPipeline): ReadonlyArray<string> =>
  pipeline.steps.map((step) => step.impl);

const planned = (
  video: SourceVideo,
  intent: VideoIntent,
  known: CapabilitySnapshot,
): VideoPipeline => {
  const result = planVideo(video, intent, known);

  if (Result.isFailure(result)) throw new Error(`no plan: ${JSON.stringify(result.failure)}`);

  return result.success.pipeline;
};

const Source = Schema.Struct({
  codec: Schema.Literals(["h264", "hevc", "av1", "vp9", "mpeg2video", "mpeg4"]),
  layout: Schema.Literals(["yuv420p", "yuvj420p", "yuv420p10le", "yuv422p10le", "yuv420p12le"]),
  colour: Schema.Literals(["sdr", "hdr10", "hlg", "dolby-vision"]),
  width: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 7680 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 4320 })),
});

const DEPTH_OF: Readonly<Record<typeof Source.Type.layout, number>> = {
  yuv420p: 8,
  yuvj420p: 8,
  yuv420p10le: 10,
  yuv422p10le: 10,
  yuv420p12le: 12,
};

const sourceFrom = (generated: typeof Source.Type): SourceVideo =>
  source({
    codec: generated.codec,
    pixelFormat: generated.layout,
    depth: DEPTH_OF[generated.layout],
    colour: generated.colour,
    width: generated.width,
    height: generated.height,
  });

const Domains = Schema.Literals(["none", "qsv", "vaapi", "both"]);

const DOMAIN_CHOICES: Readonly<Record<typeof Domains.Type, ReadonlyArray<DomainBinding>>> = {
  none: [],
  qsv: [QSV],
  vaapi: [VAAPI],
  both: [QSV, VAAPI],
};

const Mask = Schema.Array(Schema.Boolean);

const picked = <A>(items: ReadonlyArray<A>, mask: ReadonlyArray<boolean>): ReadonlyArray<A> =>
  items.filter((_, index) => mask[index % Math.max(1, mask.length)] ?? false);

describe("planVideo", () => {
  it.prop(
    "plans only chains that re-assemble from verified, allowed keys, memory to memory",
    {
      generated: Source,
      domains: Domains,
      verifiedMask: Mask,
      excludedMask: Mask,
      burn: Schema.Boolean,
    },
    ({ generated, domains, verifiedMask, excludedMask, burn }) => {
      const video = sourceFrom(generated);
      const intent = intentFor(video, { burnImage: burn ? subtitle : undefined });
      const bindings = DOMAIN_CHOICES[domains];
      const keys = everyKey(video, intent, bindings);

      const known = snapshot(
        bindings,
        picked(keys, verifiedMask),
        picked(
          VIDEO_OPS.map((entry) => entry.id),
          excludedMask,
        ),
      );

      const result = planVideo(video, intent, known);

      if (Result.isFailure(result)) return;
      const { steps } = result.success.pipeline;

      for (const step of steps) {
        assert.isTrue(known.verified.has(step.capability), step.capability);
        assert.isFalse(known.excluded.has(step.impl), step.impl);
        assert.strictEqual(step.input.memory, row(step.impl).takes, step.impl);
      }

      for (const [index, step] of steps.slice(1).entries()) {
        assert.deepStrictEqual(step.input, steps[index]?.output);
      }

      const again = assemble(
        video,
        steps.flatMap((step) =>
          Op.$is("Move")(step.op) ? [] : [[step.op, row(step.impl)] as const],
        ),
        known,
        Purpose.Run(),
      );

      assert.isTrue(Result.isSuccess(again));
      assert.deepStrictEqual(Result.isSuccess(again) ? again.success.steps : [], steps);
    },
  );

  it.prop(
    "always plans an SDR source of any layout and depth with every CPU key verified",
    {
      generated: Source,
      layout: Schema.Literals([
        "yuv444p16le",
        "gray16le",
        "gray",
        "rgb24",
        "bgr0",
        "yuva420p",
        "yuv422p",
        "yuv410p",
        "yuv420p9le",
        "yuv444p14le",
        "nv12",
        "p010le",
        "pal8",
        "monob",
      ]),
      depth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
      domains: Domains,
      burn: Schema.Boolean,
    },
    ({ generated, layout, depth, domains, burn }) => {
      const video = { ...sourceFrom({ ...generated, colour: "sdr" }), pixelFormat: layout, depth };
      const intent = intentFor(video, { burnImage: burn ? subtitle : undefined });
      const bindings = DOMAIN_CHOICES[domains];
      const cpu = everyKey(video, intent, bindings).filter((key) => row(implOf(key)).on === "cpu");
      const result = planVideo(video, intent, snapshot(bindings, cpu));

      assert.isTrue(Result.isSuccess(result));

      if (Result.isSuccess(result)) {
        assert.isAtMost(result.success.output.width, 1920);
        assert.isAtMost(result.success.output.height, 1080);
      }
    },
  );

  it("keeps the whole chain on Quick Sync when the device verified it, as today", () => {
    const video = source();
    const intent = intentFor(video);

    assert.deepStrictEqual(
      impls(planned(video, intent, snapshot([QSV, VAAPI], everyKey(video, intent, [QSV, VAAPI])))),
      ["decode.qsv", "scale.qsv", "encode.qsv.h264"],
    );
  });

  it("decodes on the CPU and keeps scaling and encoding on the GPU when only the decoder is unproven", () => {
    const video = source({ pixelFormat: "yuv420p10le", depth: 10 });
    const intent = intentFor(video);
    const keys = everyKey(video, intent, [QSV]);
    const unproven = capabilityKey(ImplId("decode.qsv"), "h264/yuv420p10le");

    const pipeline = planned(
      video,
      intent,
      snapshot(
        [QSV],
        keys.filter((key) => key !== unproven),
      ),
    );

    assert.deepStrictEqual(impls(pipeline), [
      "decode.cpu",
      "move.cpu>qsv",
      "scale.qsv",
      "encode.qsv.h264",
    ]);
    assert.deepStrictEqual(
      pipeline.steps.map((step) => step.capability),
      [
        "decode.cpu:h264/yuv420p10le",
        "move.cpu>qsv:p010le",
        "scale.qsv:10>8",
        "encode.qsv.h264:8/cbr",
      ],
    );
  });

  it("burns an image subtitle on the CPU between a download and an upload", () => {
    const video = source({ codec: "hevc", pixelFormat: "yuv420p10le", depth: 10, colour: "hdr10" });
    const intent = intentFor(video, { burnImage: subtitle });

    assert.deepStrictEqual(
      impls(planned(video, intent, snapshot([QSV], everyKey(video, intent, [QSV])))),
      [
        "decode.qsv",
        "scale.qsv",
        "tonemap.qsv",
        "move.qsv>cpu",
        "burn-image.cpu",
        "move.cpu>qsv",
        "encode.qsv.h264",
      ],
    );
  });

  it("tone-maps on the CPU and keeps the encode on the GPU when the GPU tone map is out", () => {
    const video = source({ codec: "hevc", pixelFormat: "yuv420p10le", depth: 10, colour: "hdr10" });
    const intent = intentFor(video);
    const keys = everyKey(video, intent, [QSV]);

    assert.deepStrictEqual(
      impls(planned(video, intent, snapshot([QSV], keys, [ImplId("tonemap.qsv")]))),
      ["decode.qsv", "scale.qsv", "move.qsv>cpu", "tonemap.cpu", "move.cpu>qsv", "encode.qsv.h264"],
    );
  });

  it("tone-maps for an SDR target alone, so targets of different colour plan apart only there", () => {
    const video = source({ codec: "hevc", pixelFormat: "yuv420p10le", depth: 10, colour: "hdr10" });
    const sdr = sdrTarget("hevc");
    const hdr: OutputTarget = { ...sdr, depth: 10, colour: "hdr10" };
    const keys = everyKey(video, intentFor(video, { targets: [sdr] }), []);
    const toSdr = planVideo(video, intentFor(video, { targets: [sdr] }), snapshot([], keys));
    const toHdr = planVideo(video, intentFor(video, { targets: [hdr] }), snapshot([], keys));

    assert.deepStrictEqual(
      Result.map(toSdr, ({ pipeline }) => impls(pipeline)),
      Result.succeed(["decode.cpu", "scale.cpu", "tonemap.cpu", "encode.cpu.hevc"]),
    );

    const toneMapped = Result.isSuccess(toSdr)
      ? toSdr.success.pipeline.steps.find((step) => Op.$is("ToneMap")(step.op))?.input
      : undefined;

    // No row encodes HDR, so the HDR target's chain ends refused at its encode: handed the frames
    // the SDR chain tone-maps, as it runs the same stages without the tone map.
    assert.isDefined(toneMapped);
    assert.deepStrictEqual(
      Result.isFailure(toHdr) && Rejection.$is("Refused")(toHdr.failure)
        ? toHdr.failure.frame
        : undefined,
      toneMapped,
    );
  });

  it("prefers Quick Sync to VA-API, and caps only a CPU encode at 1080p", () => {
    const video = source({ width: 3840, height: 2160 });
    const intent = intentFor(video);
    const keys = everyKey(video, intent, [QSV, VAAPI]);
    const gpu = planVideo(video, intent, snapshot([QSV, VAAPI], keys));
    const offQsv = snapshot([QSV, VAAPI], keys, [ImplId("encode.qsv.h264")]);
    const vaapi = planVideo(video, intent, offQsv);
    const cpu = planVideo(video, intent, snapshot([], keys));

    assert.deepStrictEqual(
      Result.map(gpu, ({ output }) => [output.width, output.height]),
      Result.succeed([3840, 2160]),
    );
    assert.deepStrictEqual(
      Result.map(vaapi, ({ pipeline }) => impls(pipeline)),
      Result.succeed(["decode.vaapi", "scale.vaapi", "encode.vaapi.h264"]),
    );
    assert.deepStrictEqual(
      Result.map(cpu, ({ output }) => [output.width, output.height]),
      Result.succeed([1920, 1080]),
    );
  });

  it("answers why when no chain is left", () => {
    const video = source({ colour: "hdr10", depth: 10, pixelFormat: "yuv420p10le", codec: "hevc" });
    const intent = intentFor(video);

    const withoutToneMaps = everyKey(video, intent, []).filter(
      (key) => !key.startsWith("tonemap."),
    );

    const result = planVideo(video, intent, snapshot([], withoutToneMaps));

    assert.isTrue(Result.isFailure(result) && Rejection.$is("NotVerified")(result.failure));
  });
});

const everything = (video: SourceVideo, domains: ReadonlyArray<DomainBinding>) =>
  snapshot(domains, everyKey(video, intentFor(video, { burnImage: subtitle }), domains));

describe("assemble", () => {
  it("refuses a tone map on SDR frames", () => {
    const video = source();

    const result = assemble(
      video,
      [
        [Op.Decode({ codec: "h264" }), row("decode.cpu")],
        [Op.ToneMap(), row("tonemap.cpu")],
      ],
      everything(video, []),
      Purpose.Run(),
    );

    assert.isTrue(Result.isFailure(result) && Rejection.$is("Refused")(result.failure));
  });

  it("refuses H.264 from 10-bit frames on a GPU encoder", () => {
    const video = source({ codec: "hevc", pixelFormat: "yuv420p10le", depth: 10 });

    const result = assemble(
      video,
      [
        [Op.Decode({ codec: "hevc" }), row("decode.qsv")],
        [Op.Encode({ target: sdrTarget("h264"), bitrate: 8_000_000 }), row("encode.qsv.h264")],
      ],
      everything(video, [QSV]),
      Purpose.Run(),
    );

    assert.deepStrictEqual(
      Result.isFailure(result) && Rejection.$is("Refused")(result.failure)
        ? result.failure.impl
        : undefined,
      ImplId("encode.qsv.h264"),
    );
  });

  it("refuses frames that would need a move no row makes", () => {
    const video = source();

    const result = assemble(
      video,
      [
        [Op.Decode({ codec: "h264" }), row("decode.qsv")],
        [Op.Encode({ target: sdrTarget("h264"), bitrate: 8_000_000 }), row("encode.vaapi.h264")],
      ],
      everything(video, [QSV, VAAPI]),
      Purpose.Run(),
    );

    assert.isTrue(Result.isFailure(result) && Rejection.$is("NoMove")(result.failure));
  });

  it("refuses a second GPU device context, even across the CPU", () => {
    const video = source();
    const other: DomainBinding = { domain: "vaapi", device: "/dev/dri/renderD129" };

    const result = assemble(
      video,
      [
        [Op.Decode({ codec: "h264" }), row("decode.qsv")],
        [Op.Scale({ width: 1280, height: 720, depth: 8 }), row("scale.cpu")],
        [Op.Encode({ target: sdrTarget("h264"), bitrate: 8_000_000 }), row("encode.vaapi.h264")],
      ],
      everything(video, [QSV, other]),
      Purpose.Run(),
    );

    assert.isTrue(Result.isFailure(result) && Rejection.$is("SecondDevice")(result.failure));
  });

  it("refuses an unverified step, except the one key a probe proves", () => {
    const video = source();

    const choices = [
      [Op.Decode({ codec: "h264" }), row("decode.cpu")],
      [Op.Encode({ target: sdrTarget("h264"), bitrate: 1_000_000 }), row("encode.qsv.h264")],
    ] as const;

    const keys = everyKey(video, intentFor(video), [QSV]);
    const upload = capabilityKey(ImplId("move.cpu>qsv"), "nv12");
    const encode = capabilityKey(ImplId("encode.qsv.h264"), "8/cbr");

    const without = snapshot(
      [QSV],
      keys.filter((key) => key !== upload && key !== encode),
    );

    const blocked = assemble(video, choices, without, Purpose.Probe({ key: encode }));

    assert.deepStrictEqual(
      Result.isFailure(blocked) && Rejection.$is("NotVerified")(blocked.failure)
        ? blocked.failure.key
        : undefined,
      upload,
    );

    const withUpload = snapshot([QSV], [...without.verified, upload]);

    assert.isTrue(
      Result.isSuccess(assemble(video, choices, withUpload, Purpose.Probe({ key: encode }))),
    );
    assert.isTrue(Result.isFailure(assemble(video, choices, withUpload, Purpose.Run())));
  });
});

describe("the seal", () => {
  const OPTIONS = { input: 0, stream: 0, trimPicture: undefined, trimSubtitle: undefined };

  it("refuses a chain to run that does not decode first and encode last, but not a probe's", () => {
    const video = source();
    const known = everything(video, [QSV]);

    const encodeOnly = assemble(
      video,
      [[Op.Encode({ target: sdrTarget("h264"), bitrate: 1_000_000 }), row("encode.cpu.h264")]],
      known,
      Purpose.Run(),
    );

    const decodeOnly = assemble(
      video,
      [
        [Op.Decode({ codec: "h264" }), row("decode.cpu")],
        [Op.Scale({ width: 1280, height: 720, depth: 8 }), row("scale.cpu")],
      ],
      known,
      Purpose.Run(),
    );

    const probe = assemble(
      video,
      [
        [Op.Decode({ codec: "h264" }), row("decode.qsv")],
        [Op.Move({ to: "cpu" }), row("move.qsv>cpu")],
      ],
      known,
      Purpose.Probe({ key: capabilityKey(ImplId("decode.qsv"), "h264/yuv420p") }),
    );

    assert.deepStrictEqual(
      Result.flip(encodeOnly),
      Result.succeed(Rejection.Incomplete({ needs: "Decode" })),
    );
    assert.deepStrictEqual(
      Result.flip(decodeOnly),
      Result.succeed(Rejection.Incomplete({ needs: "Encode" })),
    );
    assert.isTrue(Result.isSuccess(probe));
  });

  it("renders only a pipeline assemble returned, not a copy of one", () => {
    const video = source({ pixelFormat: "yuv420p10le", depth: 10 });
    const intent = intentFor(video);
    const unproven = capabilityKey(ImplId("decode.qsv"), "h264/yuv420p10le");

    const pipeline = planned(
      video,
      intent,
      snapshot(
        [QSV],
        everyKey(video, intent, [QSV]).filter((key) => key !== unproven),
      ),
    );

    assert.include(renderVideo(pipeline, OPTIONS).graph?.text, "hwupload");

    // A copy without the upload would feed Quick Sync's scaler frames in CPU memory.
    const withoutUpload = {
      ...pipeline,
      steps: pipeline.steps.filter((step) => !Op.$is("Move")(step.op)),
    };

    assert.throws(() => renderVideo(withoutUpload, OPTIONS), /assemble/u);
    assert.throws(() => renderVideo({ ...pipeline }, OPTIONS), /assemble/u);
  });
});

describe("warmup", () => {
  it("proves the chain most files play through first", () => {
    const first = probedSteps("qsv", snapshot([QSV], [])).slice(0, 6);

    assert.sameMembers(
      first.map((step) => step.capability),
      [
        capabilityKey(ImplId("move.cpu>qsv"), "nv12"),
        capabilityKey(ImplId("move.qsv>cpu"), "nv12"),
        capabilityKey(ImplId("encode.qsv.h264"), "8/cbr"),
        capabilityKey(ImplId("scale.qsv"), "8>8"),
        capabilityKey(ImplId("decode.qsv"), "h264/yuv420p"),
        capabilityKey(ImplId("decode.qsv"), "hevc/yuv420p"),
      ],
    );
  });
});

describe("probes", () => {
  it("prove each key with exactly that key unverified, decoders through a download", () => {
    const video = source();
    const keys = everyKey(video, intentFor(video), [VAAPI]);
    const decode = capabilityKey(ImplId("decode.vaapi"), "h264/yuv420p");

    const probe = probeFor(
      decode,
      snapshot(
        [VAAPI],
        keys.filter((key) => key !== decode),
      ),
    );

    assert.isDefined(probe);
    assert.deepStrictEqual(
      Result.isSuccess(probe) ? probe.success.pipeline.steps.map((step) => step.capability) : [],
      ["decode.vaapi:h264/yuv420p", "move.vaapi>cpu:nv12"],
    );
  });

  it("prove Quick Sync's decoder through the text its chains render: VA-API's decoder mapped into the open Quick Sync device", () => {
    const video = source();
    const keys = everyKey(video, intentFor(video), [QSV]);
    const decode = capabilityKey(ImplId("decode.qsv"), "h264/yuv420p");

    const probe = probeFor(
      decode,
      snapshot(
        [QSV],
        keys.filter((key) => key !== decode),
      ),
    );

    if (probe === undefined || Result.isFailure(probe)) throw new Error("no probe of decode.qsv");

    const rendered = renderVideo(probe.success.pipeline, {
      input: 0,
      stream: 0,
      trimPicture: undefined,
      trimSubtitle: undefined,
    });

    assert.deepStrictEqual(rendered.input, [
      "-init_hw_device",
      "vaapi=va:/dev/dri/renderD128",
      "-init_hw_device",
      "qsv=hw@va",
      "-filter_hw_device",
      "hw",
      "-hwaccel",
      "vaapi",
      "-hwaccel_output_format",
      "vaapi",
      "-hwaccel_device",
      "va",
    ]);
    assert.strictEqual(rendered.graph?.text, "hwmap,format=qsv,hwdownload,format=nv12");
  });

  it("probe a row on a GPU after its upload is proven", () => {
    const video = source();
    const keys = everyKey(video, intentFor(video), [QSV]);
    const scale = capabilityKey(ImplId("scale.qsv"), "8>8");
    const upload = capabilityKey(ImplId("move.cpu>qsv"), "nv12");

    const blocked = probeFor(
      scale,
      snapshot(
        [QSV],
        keys.filter((key) => key !== scale && key !== upload),
      ),
    );

    assert.deepStrictEqual(
      blocked !== undefined &&
        Result.isFailure(blocked) &&
        Rejection.$is("NotVerified")(blocked.failure)
        ? blocked.failure.key
        : undefined,
      upload,
    );
  });

  it("read the real source for a decoder layout no clip has", () => {
    const video = source({ pixelFormat: "yuvj420p" });
    const keys = everyKey(video, intentFor(video), [QSV]);
    const decode = capabilityKey(ImplId("decode.qsv"), "h264/yuvj420p");

    const known = snapshot(
      [QSV],
      keys.filter((key) => key !== decode),
    );

    assert.isUndefined(probeFor(decode, known));
    assert.isTrue(Result.isSuccess(sourceProbeFor(decode, video, known) ?? Result.fail(undefined)));
  });

  it("exist for every variant a chain on this table can need, except decoder layouts", () => {
    const video = source({ codec: "hevc", pixelFormat: "yuv420p10le", depth: 10, colour: "hdr10" });
    const domains = [QSV, VAAPI];

    const keys = [
      ...everyKey(video, intentFor(video, { burnImage: subtitle }), domains),
      ...everyKey(source(), intentFor(source(), { burnImage: subtitle }), domains),
    ];

    const all = snapshot(domains, keys);

    for (const key of new Set(keys)) {
      assert.isDefined(probeFor(key, all), key);
    }

    assert.isAbove(rowsOf("Decode").length, 2);
  });
});

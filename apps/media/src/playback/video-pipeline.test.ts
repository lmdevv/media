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
  ProbeInput,
  Purpose,
  Rejection,
  rowOf,
  rowsOf,
  sourceOf,
  sourceProbeFor,
  type VideoIntent,
  type VideoPipeline,
  VIDEO_OPS,
} from "./video-pipeline.ts";
import type { VideoStream } from "../media/media-probe.ts";
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
import { colourOf, DOLBY_VISION_IPT, HDR10, SDR_BT709 } from "../testing/colours.ts";

const QSV: DomainBinding = { domain: "qsv", device: "/dev/dri/renderD128" };

const VAAPI: DomainBinding = { domain: "vaapi", device: "/dev/dri/renderD128" };

const source = (overrides: Partial<SourceVideo> = {}): SourceVideo => ({
  codec: "h264",
  pixelFormat: "yuv420p",
  depth: 8,
  colour: SDR_BT709,
  scan: "progressive",
  width: 1920,
  height: 1080,
  ...overrides,
});

const intentFor = (video: SourceVideo, overrides: Partial<VideoIntent> = {}): VideoIntent => ({
  targets: [sdrTarget("h264")],
  frameRate: undefined,
  bounds: { width: 3840, height: 2160 },
  cpuEncodeBounds: { width: 1920, height: 1080 },
  maxBitrate: undefined,
  burn: undefined,
  ...overrides,
});

const subtitle = {
  input: 0,
  stream: 3,
  codec: "dvd_subtitle",
  frame: {
    memory: "cpu" as const,
    device: undefined,
    colour: SDR_BT709,
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

/** `keys` on a device whose Vulkan is not proven: without libplacebo's tone map. */
const withoutPlacebo = (keys: ReadonlyArray<CapabilityKey>): ReadonlyArray<CapabilityKey> =>
  keys.filter((key) => !implOf(key).endsWith(".placebo"));

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
  colour: Schema.Literals(["sdr", "pq", "hlg", "dovi"]),
  scan: Schema.Literals(["progressive", "interlaced"]),
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
    colour: colourOf(generated.colour),
    scan: generated.scan,
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
      const intent = intentFor(video, { burn: burn ? Op.BurnImage({ subtitle }) : undefined });
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
      const intent = intentFor(video, { burn: burn ? Op.BurnImage({ subtitle }) : undefined });
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

  it.prop(
    "deinterlaces exactly the interlaced sources, right after they decode, and encodes progressive frames",
    { generated: Source, domains: Domains, burn: Schema.Boolean },
    ({ generated, domains, burn }) => {
      const video = sourceFrom(generated);
      const intent = intentFor(video, { burn: burn ? Op.BurnImage({ subtitle }) : undefined });
      const bindings = DOMAIN_CHOICES[domains];
      const known = snapshot(bindings, everyKey(video, intent, bindings));
      const result = planVideo(video, intent, known);

      if (Result.isFailure(result)) return;
      const work = result.success.pipeline.steps.filter((step) => !Op.$is("Move")(step.op));
      // A row's id names its operation first: `deinterlace.cpu.yadif`.
      const ops = work.map((step) => step.impl.split(".")[0]);
      const interlaced = video.scan === "interlaced";

      assert.deepStrictEqual(ops.slice(0, 2), ["decode", interlaced ? "deinterlace" : "scale"]);
      assert.strictEqual(ops.filter((op) => op === "deinterlace").length, interlaced ? 1 : 0);
      assert.isTrue(
        work.slice(interlaced ? 2 : 1).every((step) => step.input.scan === "progressive"),
      );
    },
  );

  it("keeps an interlaced source's chain on the GPU, deinterlacing in Quick Sync's scaling filter", () => {
    const video = source({ codec: "mpeg2video", scan: "interlaced", width: 720, height: 576 });
    const intent = intentFor(video);

    for (const binding of [QSV, VAAPI]) {
      const pipeline = planned(
        video,
        intent,
        snapshot([binding], everyKey(video, intent, [binding])),
      );

      assert.deepStrictEqual(impls(pipeline), [
        `decode.${binding.domain}`,
        `deinterlace.${binding.domain}`,
        `scale.${binding.domain}`,
        `encode.${binding.domain}.h264`,
      ]);

      const rendered = renderVideo(pipeline, {
        input: 0,
        stream: 0,
        trimPicture: undefined,
        trimSubtitle: undefined,
        files: {},
      });

      assert.strictEqual(
        rendered.graph?.text,
        binding.domain === "qsv"
          ? "hwmap,format=qsv,vpp_qsv=deinterlace=advanced:rate=frame:w=720:h=576:format=nv12,fps=source_fps"
          : "deinterlace_vaapi=mode=bob:rate=frame:auto=1,scale_vaapi=w=720:h=576:format=nv12",
      );
      // Quick Sync's filters are followed by the restated rate, so they need `fps` from the build.
      assert.deepStrictEqual(
        pipeline.steps.find((step) => step.impl === `deinterlace.${binding.domain}`)?.needs,
        binding.domain === "qsv" ? ["filter:vpp_qsv", "filter:fps"] : ["filter:deinterlace_vaapi"],
      );
    }
  });

  it("deinterlaces on the CPU between a GPU decode and a GPU encode when the GPU's deinterlacer is out", () => {
    const video = source({ codec: "mpeg2video", scan: "interlaced", width: 720, height: 576 });
    const intent = intentFor(video);

    for (const binding of [QSV, VAAPI]) {
      const { domain } = binding;
      const keys = everyKey(video, intent, [binding]);
      const unproven = capabilityKey(ImplId(`deinterlace.${domain}`), "8");

      const expected = [
        `decode.${domain}`,
        `move.${domain}>cpu`,
        "deinterlace.cpu",
        `move.cpu>${domain}`,
        `scale.${domain}`,
        `encode.${domain}.h264`,
      ];

      assert.include(keys, unproven);
      assert.deepStrictEqual(
        impls(
          planned(
            video,
            intent,
            snapshot(
              [binding],
              keys.filter((key) => key !== unproven),
            ),
          ),
        ),
        expected,
      );
      assert.deepStrictEqual(
        impls(planned(video, intent, snapshot([binding], keys, [ImplId(`deinterlace.${domain}`)]))),
        expected,
      );
    }
  });

  it("deinterlaces with yadif only where bwdif is not verified", () => {
    const video = source({ codec: "mpeg2video", scan: "interlaced", width: 720, height: 576 });
    const intent = intentFor(video);
    const keys = everyKey(video, intent, []);
    const bwdif = capabilityKey(ImplId("deinterlace.cpu"), "8");

    assert.deepStrictEqual(impls(planned(video, intent, snapshot([], keys))), [
      "decode.cpu",
      "deinterlace.cpu",
      "scale.cpu",
      "encode.cpu.h264",
    ]);
    assert.deepStrictEqual(
      impls(
        planned(
          video,
          intent,
          snapshot(
            [],
            keys.filter((key) => key !== bwdif),
          ),
        ),
      ),
      ["decode.cpu", "deinterlace.cpu.yadif", "scale.cpu", "encode.cpu.h264"],
    );
  });

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

  it("burns an image subtitle on the GPU after the tone map, the picture kept on the device", () => {
    const video = source({ codec: "hevc", pixelFormat: "yuv420p10le", depth: 10, colour: HDR10 });
    const intent = intentFor(video, { burn: Op.BurnImage({ subtitle }) });

    for (const domain of [QSV, VAAPI]) {
      const keys = withoutPlacebo(everyKey(video, intent, [domain]));
      const on = domain.domain;

      assert.deepStrictEqual(impls(planned(video, intent, snapshot([domain], keys))), [
        `decode.${on}`,
        `scale.${on}`,
        `tonemap.${on}`,
        `burn-image.${on}`,
        `encode.${on}.h264`,
      ]);
      // A device or build without the GPU overlay loses only that key: the subtitle is drawn on the
      // CPU between a download and an upload, as before.
      assert.deepStrictEqual(
        impls(
          planned(
            video,
            intent,
            snapshot(
              [domain],
              keys.filter((key) => implOf(key) !== `burn-image.${on}`),
            ),
          ),
        ),
        [
          `decode.${on}`,
          `scale.${on}`,
          `tonemap.${on}`,
          `move.${on}>cpu`,
          "burn-image.cpu",
          `move.cpu>${on}`,
          `encode.${on}.h264`,
        ],
      );
    }
  });

  it("draws a text subtitle with libass on the CPU between GPU stages, after the tone map", () => {
    const video = source({ codec: "hevc", pixelFormat: "yuv420p10le", depth: 10, colour: HDR10 });

    const intent = intentFor(video, {
      burn: Op.BurnText({
        subtitle: { codec: "ass", style: "styled", storage: { width: 1920, height: 1080 } },
      }),
    });

    assert.deepStrictEqual(
      impls(
        planned(video, intent, snapshot([QSV], withoutPlacebo(everyKey(video, intent, [QSV])))),
      ),
      [
        "decode.qsv",
        "scale.qsv",
        "tonemap.qsv",
        "move.qsv>cpu",
        "burn-text.cpu",
        "move.cpu>qsv",
        "encode.qsv.h264",
      ],
    );
    assert.deepStrictEqual(
      impls(planned(video, intent, snapshot([], everyKey(video, intent, [])))),
      ["decode.cpu", "scale.cpu", "tonemap.cpu", "burn-text.cpu", "encode.cpu.h264"],
    );
  });

  it("tone-maps on the CPU and keeps the encode on the GPU when the GPU tone map is out", () => {
    const video = source({ codec: "hevc", pixelFormat: "yuv420p10le", depth: 10, colour: HDR10 });
    const intent = intentFor(video);
    const keys = withoutPlacebo(everyKey(video, intent, [QSV]));

    assert.deepStrictEqual(
      impls(planned(video, intent, snapshot([QSV], keys, [ImplId("tonemap.qsv")]))),
      ["decode.qsv", "scale.qsv", "move.qsv>cpu", "tonemap.cpu", "move.cpu>qsv", "encode.qsv.h264"],
    );
  });

  it("prefers libplacebo's tone map on a GPU that proved it, the GPU's own and the CPU's after", () => {
    const video = source({ codec: "hevc", pixelFormat: "yuv420p10le", depth: 10, colour: HDR10 });
    const intent = intentFor(video);

    for (const domain of [QSV, VAAPI]) {
      const on = domain.domain;
      const keys = everyKey(video, intent, [domain]);

      const toneMap = (excluded: ReadonlyArray<string>) =>
        impls(planned(video, intent, snapshot([domain], keys, excluded.map(ImplId)))).filter(
          (impl) => impl.startsWith("tonemap."),
        );

      assert.deepStrictEqual(toneMap([]), [`tonemap.${on}.placebo`]);
      assert.deepStrictEqual(toneMap([`tonemap.${on}.placebo`]), [`tonemap.${on}`]);
      assert.deepStrictEqual(toneMap([`tonemap.${on}.placebo`, `tonemap.${on}`]), ["tonemap.cpu"]);
    }
  });

  it("maps Dolby Vision's IPT only with libplacebo, which shares PQ's key", () => {
    const video = source({
      codec: "hevc",
      pixelFormat: "yuv420p10le",
      depth: 10,
      colour: DOLBY_VISION_IPT,
    });

    const intent = intentFor(video);
    const keys = everyKey(video, intent, [QSV]);
    const steps = planned(video, intent, snapshot([QSV], keys)).steps;

    assert.deepStrictEqual(
      steps.filter((step) => Op.$is("ToneMap")(step.op)).map((step) => step.capability),
      ["tonemap.qsv.placebo:pq"],
    );
    assert.isTrue(
      Result.isFailure(planVideo(video, intent, snapshot([QSV], withoutPlacebo(keys)))),
      "no other tone map takes IPT",
    );
    assert.isTrue(
      Result.isFailure(planVideo(video, intent, snapshot([], everyKey(video, intent, [])))),
    );
  });

  it("tone-maps for an SDR target alone, so targets of different colour plan apart only there", () => {
    const video = source({ codec: "hevc", pixelFormat: "yuv420p10le", depth: 10, colour: HDR10 });
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
    const video = source({ colour: HDR10, depth: 10, pixelFormat: "yuv420p10le", codec: "hevc" });
    const intent = intentFor(video);

    const withoutToneMaps = everyKey(video, intent, []).filter(
      (key) => !key.startsWith("tonemap."),
    );

    const result = planVideo(video, intent, snapshot([], withoutToneMaps));

    assert.isTrue(Result.isFailure(result) && Rejection.$is("NotVerified")(result.failure));
  });
});

const everything = (video: SourceVideo, domains: ReadonlyArray<DomainBinding>) =>
  snapshot(
    domains,
    everyKey(video, intentFor(video, { burn: Op.BurnImage({ subtitle }) }), domains),
  );

/** An SD 8-bit SDR stream of `codec` whose probe read `fieldOrder`. */
const streamOf = (codec: string, fieldOrder: VideoStream["fieldOrder"]): VideoStream => ({
  index: 0,
  codec,
  bitDepth: 8,
  width: 720,
  height: 576,
  dynamicRange: "sdr",
  fieldOrder,
});

describe("sourceOf", () => {
  it("plans a stream interlaced when it says a field order, or says none in a codec that codes fields", () => {
    const cases: ReadonlyArray<readonly [string, VideoStream["fieldOrder"], SourceVideo["scan"]]> =
      [
        ["mpeg2video", "tff", "interlaced"],
        ["h264", "bff", "interlaced"],
        ["hevc", "tff", "interlaced"],
        ["mpeg2video", "progressive", "progressive"],
        ["h264", "progressive", "progressive"],
        ["mpeg4", "unknown", "interlaced"],
        ["dvvideo", "unknown", "interlaced"],
        ["hevc", "unknown", "progressive"],
        ["av1", "unknown", "progressive"],
        ["vp9", "unknown", "progressive"],
        // A probe stored before field orders were read, until a scan reads the file again.
        ["mpeg2video", undefined, "progressive"],
      ];

    for (const [codec, fieldOrder, scan] of cases) {
      assert.strictEqual(
        sourceOf(streamOf(codec, fieldOrder)).scan,
        scan,
        `${codec} ${String(fieldOrder)}`,
      );
    }
  });

  it("deinterlaces H.264 that says no field order where its frames already are, adding no move", () => {
    // H.264 says no field order where no parser reads its stream, as in NUT, whether its frames
    // are fields or progressive; progressive frames pass each deinterlacer untouched.
    const silent = sourceOf(streamOf("h264", "unknown"));
    const progressive = sourceOf(streamOf("h264", "progressive"));
    const intent = intentFor(silent);

    for (const bindings of [[], [QSV], [VAAPI]]) {
      const domain = bindings[0]?.domain ?? "cpu";

      const chain = (video: SourceVideo) =>
        impls(planned(video, intent, snapshot(bindings, everyKey(video, intent, bindings))));

      assert.deepStrictEqual(
        chain(silent),
        chain(progressive).toSpliced(1, 0, `deinterlace.${domain}`),
        domain,
      );
    }
  });
});

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
        [
          Op.Encode({ target: sdrTarget("h264"), bitrate: 8_000_000, level: undefined }),
          row("encode.qsv.h264"),
        ],
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
        [
          Op.Encode({ target: sdrTarget("h264"), bitrate: 8_000_000, level: undefined }),
          row("encode.vaapi.h264"),
        ],
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
        [
          Op.Encode({ target: sdrTarget("h264"), bitrate: 8_000_000, level: undefined }),
          row("encode.vaapi.h264"),
        ],
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
      [
        Op.Encode({ target: sdrTarget("h264"), bitrate: 1_000_000, level: undefined }),
        row("encode.qsv.h264"),
      ],
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
  const OPTIONS = {
    input: 0,
    stream: 0,
    trimPicture: undefined,
    trimSubtitle: undefined,
    files: {},
  };

  it("refuses a chain to run that does not decode first and encode last, but not a probe's", () => {
    const video = source();
    const known = everything(video, [QSV]);

    const encodeOnly = assemble(
      video,
      [
        [
          Op.Encode({ target: sdrTarget("h264"), bitrate: 1_000_000, level: undefined }),
          row("encode.cpu.h264"),
        ],
      ],
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
      files: {},
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

  it("prove a GPU deinterlacer on an interlaced clip, uploaded after a CPU decode", () => {
    const keys = [
      source({ codec: "mpeg2video", scan: "interlaced" }),
      source({ pixelFormat: "yuv420p10le", depth: 10, scan: "interlaced" }),
    ].flatMap((video) => everyKey(video, intentFor(video), [VAAPI]));

    for (const [depth, clip] of [
      ["8", "mpeg2-8-interlaced"],
      ["10", "h264-10-interlaced"],
    ] as const) {
      const key = capabilityKey(ImplId("deinterlace.vaapi"), depth);
      const probe = probeFor(key, snapshot([VAAPI], keys));

      if (probe === undefined || Result.isFailure(probe)) throw new Error(`no probe of ${key}`);

      assert.deepStrictEqual(probe.success.input, ProbeInput.Clip({ clip }));
      assert.deepStrictEqual(impls(probe.success.pipeline), [
        "decode.cpu",
        "move.cpu>vaapi",
        "deinterlace.vaapi",
      ]);
    }
  });

  it("exist for every variant a chain on this table can need, except decoder layouts", () => {
    const video = source({ codec: "hevc", pixelFormat: "yuv420p10le", depth: 10, colour: HDR10 });
    const interlaced = source({ codec: "mpeg2video", scan: "interlaced" });
    const domains = [QSV, VAAPI];

    const keys = [
      ...everyKey(video, intentFor(video, { burn: Op.BurnImage({ subtitle }) }), domains),
      ...everyKey(source(), intentFor(source(), { burn: Op.BurnImage({ subtitle }) }), domains),
      ...everyKey(interlaced, intentFor(interlaced), domains),
      ...everyKey({ ...video, scan: "interlaced" }, intentFor(video), domains),
    ];

    const all = snapshot(domains, keys);

    for (const key of new Set(keys)) {
      assert.isDefined(probeFor(key, all), key);
    }

    assert.isAbove(rowsOf("Decode").length, 2);
  });
});

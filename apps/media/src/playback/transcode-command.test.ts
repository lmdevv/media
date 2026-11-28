import { Result } from "effect";
import { describe, expect, it } from "vitest";

import { AudioPlan, VideoPlan } from "./playback-decision.ts";
import type { HlsCommand } from "./transcode-command.ts";
import { hlsCommand, mp4CommandArgs } from "./transcode-command.ts";
import {
  candidateKeys,
  type DomainBinding,
  planVideo,
  type VideoIntent,
} from "./video-pipeline.ts";
import {
  type Colour,
  ImplId,
  Op,
  type OutputCodec,
  sdrTarget,
  type SourceVideo,
} from "./video-ops.ts";
import { HDR10, SDR_BT709 } from "../testing/colours.ts";

const hlsCommandArgs = (command: HlsCommand): ReadonlyArray<string> => hlsCommand(command).args;

const command = (audio: AudioPlan, audioCodec: string): HlsCommand => ({
  input: "/media/Film (2021).ts",
  sourceStart: 1.4,
  from: 1.4,
  videoIndex: 0,
  videoCodec: "h264",
  video: VideoPlan.Copy({ dolbyVision: "none" }),
  audio,
  audioCodec,
  copiedAudioEnd: undefined,
  segmentStarts: [1.4, 3.4],
  files: {},
  previousStart: undefined,
  outputDirectory: "/tmp/stream/1",
});

const audioPart = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.slice(args.indexOf("0:1") - 1, args.indexOf("-map_metadata"));

interface EncodeOptions {
  readonly codec?: string;
  /** What the encode produces; H.264 when absent. */
  readonly output?: OutputCodec;
  /** The level the client declared for `output`, in ffprobe's units. */
  readonly level?: number;
  readonly bitDepth?: number;
  readonly toneMap?: boolean;
  /** The source holds fields, so the plan deinterlaces it. */
  readonly interlaced?: boolean;
  readonly burnSubtitle?: number;
  readonly subtitleCodec?: string;
  readonly device?: string;
  /** Rows the plan keeps off, as a file or session whose GPU stage failed does. */
  readonly without?: ReadonlyArray<string>;
  /** A text track drawn in, styled (ASS) or plain, in place of an image subtitle. */
  readonly burnText?: "styled" | "plain";
  /**
   * The source's picture, 1920x1080 when absent; a GPU encodes it at its own size, the CPU within
   * 1920x1080.
   */
  readonly size?: { readonly width: number; readonly height: number };
  /** The device proved libplacebo's tone map too, which a chain then prefers to its own. */
  readonly placebo?: boolean;
  /** An SDR source's colour, in place of BT.709 in limited range. */
  readonly colour?: Colour;
}

const DEVICES = { qsv: "/dev/dri/renderD128", vaapi: "/dev/dri/renderD129" } as const;

/**
 * The plan a 1920x1080 source (or one of `size`) gets on `domain` (and the CPU) when the device
 * verified everything but libplacebo's tone map, unless asked: an 8 Mbit/s H.264 encode at its
 * size, or `output` at its share of that, tone-mapped from HDR10 when asked.
 */
const encode = (domain: "qsv" | "vaapi" | "software", options: EncodeOptions) => {
  const depth = options.bitDepth ?? 8;
  const toneMap = options.toneMap ?? false;

  const source: SourceVideo = {
    codec: options.codec ?? "h264",
    pixelFormat: depth > 8 ? "yuv420p10le" : "yuv420p",
    depth,
    colour: toneMap ? HDR10 : (options.colour ?? SDR_BT709),
    scan: options.interlaced === true ? "interlaced" : "progressive",
    width: options.size?.width ?? 1920,
    height: options.size?.height ?? 1080,
  };

  const intent: VideoIntent = {
    targets: [{ ...sdrTarget(options.output ?? "h264"), level: options.level }],
    frameRate: undefined,
    bounds: options.size ?? { width: 1920, height: 1080 },
    cpuEncodeBounds: { width: 1920, height: 1080 },
    maxBitrate: undefined,
    burn:
      options.burnText !== undefined
        ? Op.BurnText({
            subtitle: {
              codec: options.burnText === "styled" ? "ass" : "subrip",
              style: options.burnText,
              storage: { width: 1920, height: 1080 },
            },
          })
        : options.burnSubtitle === undefined
          ? undefined
          : Op.BurnImage({
              subtitle: {
                input: 0,
                stream: options.burnSubtitle,
                codec: options.subtitleCodec ?? "hdmv_pgs_subtitle",
                frame: {
                  memory: "cpu",
                  device: undefined,
                  colour: SDR_BT709,
                  depth: 8,
                  pixelFormat: "pal8",
                  scan: "progressive",
                  width: source.width,
                  height: source.height,
                },
              },
            }),
  };

  const domains: ReadonlyArray<DomainBinding> =
    domain === "software" ? [] : [{ domain, device: options.device ?? DEVICES[domain] }];

  const keys = candidateKeys(source, intent, { domains, verified: new Set(), excluded: new Set() });

  const planned = planVideo(source, intent, {
    domains,
    verified: new Set(
      [...keys.keys()].filter((key) => options.placebo === true || !key.includes(".placebo:")),
    ),
    excluded: new Set((options.without ?? []).map(ImplId)),
  });

  if (Result.isFailure(planned)) throw new Error(JSON.stringify(planned.failure));

  return VideoPlan.Encode({ intent, ...planned.success });
};

const dvd = (from: number) =>
  hlsCommandArgs({
    ...command(AudioPlan.Copy({ index: 1 }), "aac"),
    from,
    video: encode("software", { burnSubtitle: 3, subtitleCodec: "dvd_subtitle" }),
  });

/** What the CPU row does to a PGS canvas: scales it to the picture's height, then keeps its middle. */
const pgsOnCpu = (width: number, height: number) => {
  const scaled = Math.round((1920 * height) / 1080);

  return `scale=${String(scaled)}:${String(height)}${scaled > width ? `,crop=${String(width)}:${String(height)}` : ""}`;
};

const after = (args: ReadonlyArray<string>, flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

/** The video filters of an 8-bit H.264 source's run on Quick Sync, in `colour`. */
const qsvScale = (colour: Colour) =>
  after(
    hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("qsv", { colour }),
    }),
    "-vf",
  );

/** The video filters of a 10-bit HDR10 HEVC source's run on `domain`, libplacebo proven. */
const placeboRun = (domain: "qsv" | "vaapi") =>
  after(
    hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "hevc",
      video: encode(domain, { codec: "hevc", bitDepth: 10, toneMap: true, placebo: true }),
    }),
    "-vf",
  );

const inputs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.slice(
    args.findIndex((arg) => ["-canvas_size", "-ss", "-copyts"].includes(arg)),
    args.lastIndexOf("-i") + 2,
  );

/** Each step of `plan`'s pipeline, and whether it needs the `fps` filter from the build. */
const fps = (plan: VideoPlan): ReadonlyArray<readonly [string, boolean]> =>
  VideoPlan.$is("Encode")(plan)
    ? plan.pipeline.steps.map((step) => [step.impl, step.needs.includes("filter:fps")] as const)
    : [];

/** How many times the filter graphs of `args` restate the frame rate. */
const restatements = (args: ReadonlyArray<string>): number =>
  [
    ...args
      .filter((_, index) => /^-(vf|filter_complex)$/u.test(args[index - 1] ?? ""))
      .join(";")
      .matchAll(/fps=/gu),
  ].length;

/** The run that plays interlaced MPEG-2 on `domain` from the start. */
const interlacedRun = (domain: "qsv" | "vaapi" | "software", options: EncodeOptions = {}) =>
  hlsCommand({
    ...command(AudioPlan.Copy({ index: 1 }), "aac"),
    videoCodec: "mpeg2video",
    video: encode(domain, { codec: "mpeg2video", interlaced: true, ...options }),
  });

describe("hlsCommandArgs", () => {
  it("rewrites ADTS headers of copied AAC, which MPEG-TS files carry and MP4 refuses", () => {
    expect(audioPart(hlsCommandArgs(command(AudioPlan.Copy({ index: 1 }), "aac")))).toStrictEqual([
      "-map",
      "0:1",
      "-c:a",
      "copy",
      "-bsf:a",
      "aac_adtstoasc,noise=drop=lt(pts*tb\\,0.000000)",
    ]);
  });

  it("copies other codecs without the AAC filter, and encodes AAC without it", () => {
    expect(audioPart(hlsCommandArgs(command(AudioPlan.Copy({ index: 1 }), "ac3")))).toStrictEqual([
      "-map",
      "0:1",
      "-c:a",
      "copy",
      "-bsf:a",
      "noise=drop=lt(pts*tb\\,0.000000)",
    ]);
    expect(hlsCommandArgs(command(AudioPlan.Aac({ index: 1 }), "ac3"))).not.toContain(
      "aac_adtstoasc",
    );
  });

  it("opens Quick Sync on the configured render node, derived from a VA-API device there", () => {
    // oneVPL builds ignore the path in `qsv=hw:<path>` and use the default GPU; the node must be
    // the VA-API device Quick Sync derives from, so a wrong one fails (and is replaced) instead of
    // encoding elsewhere.
    const args = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("qsv", { device: "/dev/dri/renderD130" }),
    });

    expect(args.slice(args.indexOf("-init_hw_device"), args.indexOf("-hwaccel"))).toEqual([
      "-init_hw_device",
      "vaapi=va:/dev/dri/renderD130",
      "-init_hw_device",
      "qsv=hw@va",
      "-filter_hw_device",
      "hw",
    ]);
  });

  it("decodes for Quick Sync with VA-API and maps the surfaces into Quick Sync", () => {
    const args = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("qsv", {}),
    });

    expect(args.slice(args.indexOf("-hwaccel"), args.indexOf("-copyts"))).toEqual([
      "-hwaccel",
      "vaapi",
      "-hwaccel_output_format",
      "vaapi",
      "-hwaccel_device",
      "va",
    ]);
    expect(after(args, "-vf")).toBe(
      "hwmap,format=qsv,vpp_qsv=w=1920:h=1080:format=nv12,fps=source_fps",
    );
    expect(after(args, "-c:v")).toBe("h264_qsv");
  });

  it("states an SDR source's own colour on Quick Sync's scale, which would convert it", () => {
    const bt601: Colour = {
      signal: "sdr",
      transfer: "smpte170m",
      primaries: "smpte170m",
      matrix: "smpte170m",
      range: "limited",
      mastering: "absent",
    };

    expect(qsvScale(bt601)).toBe(
      "hwmap,format=qsv,vpp_qsv=w=1920:h=1080:format=nv12:out_color_matrix=smpte170m:out_color_primaries=smpte170m:out_color_transfer=smpte170m,fps=source_fps",
    );
    expect(qsvScale({ ...SDR_BT709, range: "full" })).toBe(
      "hwmap,format=qsv,vpp_qsv=w=1920:h=1080:format=nv12:out_range=full,fps=source_fps",
    );
    expect(
      qsvScale({ ...SDR_BT709, transfer: undefined, primaries: undefined, matrix: undefined }),
    ).toBe("hwmap,format=qsv,vpp_qsv=w=1920:h=1080:format=nv12,fps=source_fps");
  });

  it("tone-maps with libplacebo on a GPU that proved it, through CPU memory and back", () => {
    const placebo =
      "hwdownload,format=p010le,libplacebo=format=nv12:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=bt.2390:peak_detect=0:contrast_recovery=0:apply_dolbyvision=0,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,sidedata=mode=delete:type=DOVI_METADATA,sidedata=mode=delete:type=DOVI_RPU_BUFFER";

    expect(placeboRun("vaapi")).toBe(`scale_vaapi=w=1920:h=1080:format=p010,${placebo},hwupload`);
    expect(placeboRun("qsv")).toBe(
      `hwmap,format=qsv,vpp_qsv=w=1920:h=1080:format=p010,${placebo},hwupload=extra_hw_frames=64,format=qsv,fps=source_fps`,
    );
  });

  it("encodes on VA-API, decoding, scaling in 10 bits, then tone-mapping on the GPU", () => {
    const args = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "hevc",
      video: encode("vaapi", { codec: "hevc", bitDepth: 10, toneMap: true }),
    });

    expect(args.slice(args.indexOf("-init_hw_device"), args.indexOf("-copyts"))).toStrictEqual([
      "-init_hw_device",
      "vaapi=va:/dev/dri/renderD129",
      "-filter_hw_device",
      "va",
      "-hwaccel",
      "vaapi",
      "-hwaccel_output_format",
      "vaapi",
      "-hwaccel_device",
      "va",
    ]);
    expect(after(args, "-vf")).toBe(
      "scale_vaapi=w=1920:h=1080:format=p010,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,sidedata=mode=delete:type=DOVI_METADATA,sidedata=mode=delete:type=DOVI_RPU_BUFFER",
    );
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-force_key_frames"))).toStrictEqual([
      "-c:v",
      "h264_vaapi",
      "-profile:v",
      "high",
      "-b:v",
      "8000000",
      "-maxrate",
      "8000000",
      "-bufsize",
      "16000000",
    ]);
    expect(after(args, "-force_key_frames")).toBe("1.400000,3.400000");
  });

  it.each<OutputCodec>(["h264", "hevc", "av1"])(
    "tags %s tone-mapped on Quick Sync as BT.709 SDR and drops the source's HDR metadata",
    (output) => {
      const args = hlsCommandArgs({
        ...command(AudioPlan.Copy({ index: 1 }), "aac"),
        videoCodec: "hevc",
        video: encode("qsv", { codec: "hevc", bitDepth: 10, toneMap: true, output }),
      });

      expect(after(args, "-vf")).toBe(
        [
          "hwmap",
          "format=qsv",
          "vpp_qsv=w=1920:h=1080:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709",
          "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
          "sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA",
          "sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL",
          "sidedata=mode=delete:type=DYNAMIC_HDR_PLUS",
          "sidedata=mode=delete:type=DOVI_METADATA",
          "sidedata=mode=delete:type=DOVI_RPU_BUFFER",
          "fps=source_fps",
        ].join(","),
      );
    },
  );

  it("restates the frame rate once after Quick Sync's filters, and on no other path", () => {
    // ffmpeg 7.1's Quick Sync filters leave each frame's duration in the input's time base, which
    // ffmpeg's constant-rate output reads as frames to repeat.
    const scaled = hlsCommand({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("qsv", {}),
    });

    const toneMapped = hlsCommand({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "hevc",
      video: encode("qsv", { codec: "hevc", bitDepth: 10, toneMap: true }),
    });

    const burned = hlsCommand({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("qsv", { burnSubtitle: 3 }),
    });

    const burnedOnCpu = hlsCommand({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("qsv", { burnSubtitle: 3, without: ["burn-image.qsv"] }),
    });

    expect(
      [scaled, toneMapped, burned, burnedOnCpu].map((run) => restatements(run.args)),
    ).toStrictEqual([1, 1, 1, 1]);
    // It is the scale's, then the tone map's, then the overlay's, so a failure in it reads back to
    // that step; with the overlay on the CPU, the scale's again, before the download.
    expect(scaled.owners?.filters.get("Parsed_fps_3")).toStrictEqual([1]);
    expect(toneMapped.owners?.filters.get("Parsed_fps_9")).toStrictEqual([2]);
    expect(after(burned.args, "-filter_complex")?.split(";")[2]).toContain("fps=source_fps[video]");
    expect(burned.owners?.filters.get("Parsed_fps_7")).toStrictEqual([2]);
    expect(after(burnedOnCpu.args, "-filter_complex")?.split(";")[2]).not.toContain("fps=");

    // Each step the restatement follows needs the filter from the build, so a build without it
    // loses those rows; the decoder and the encoder do not.
    expect(fps(encode("qsv", { codec: "hevc", bitDepth: 10, toneMap: true }))).toStrictEqual([
      ["decode.qsv", false],
      ["scale.qsv", true],
      ["tonemap.qsv", true],
      ["encode.qsv.h264", false],
    ]);
    expect(
      fps(encode("vaapi", { codec: "hevc", bitDepth: 10, toneMap: true })).filter(
        ([, needed]) => needed,
      ),
    ).toStrictEqual([]);

    for (const domain of ["vaapi", "software"] as const) {
      for (const options of [
        {},
        { codec: "hevc", bitDepth: 10, toneMap: true },
        { burnSubtitle: 3 },
      ]) {
        expect(
          restatements(
            hlsCommandArgs({
              ...command(AudioPlan.Copy({ index: 1 }), "aac"),
              video: encode(domain, options),
            }),
          ),
        ).toBe(0);
      }
    }
  });

  it("deinterlaces right after decoding at the source's frame rate, frames flagged interlaced only", () => {
    expect(after(interlacedRun("software").args, "-vf")).toBe(
      "bwdif=mode=send_frame:deint=interlaced,scale=1920:1080:flags=bicubic,format=yuv420p",
    );
    expect(after(interlacedRun("vaapi").args, "-vf")).toBe(
      "deinterlace_vaapi=mode=bob:rate=frame:auto=1,scale_vaapi=w=1920:h=1080:format=nv12",
    );

    // Quick Sync deinterlaces in the `vpp_qsv` that scales, and the restated rate belongs to both.
    const qsv = interlacedRun("qsv");

    expect(after(qsv.args, "-vf")).toBe(
      "hwmap,format=qsv,vpp_qsv=deinterlace=advanced:rate=frame:w=1920:h=1080:format=nv12,fps=source_fps",
    );
    expect(qsv.owners?.filters.get("Parsed_vpp_qsv_2")).toStrictEqual([1, 2]);
    expect(qsv.owners?.filters.get("Parsed_fps_3")).toStrictEqual([1, 2]);

    // A burned-in subtitle is drawn on the deinterlaced picture.
    expect(
      after(interlacedRun("software", { burnSubtitle: 3 }).args, "-filter_complex")?.split(";")[0],
    ).toBe("[0:0]bwdif=mode=send_frame:deint=interlaced,scale=1920:1080:flags=bicubic[picture]");
    expect(
      after(interlacedRun("qsv", { burnSubtitle: 3 }).args, "-filter_complex")?.split(";")[0],
    ).toBe(
      "[0:0]hwmap,format=qsv,vpp_qsv=deinterlace=advanced:rate=frame:w=1920:h=1080:format=nv12[picture]",
    );
    expect(
      after(
        interlacedRun("qsv", { burnSubtitle: 3, without: ["burn-image.qsv"] }).args,
        "-filter_complex",
      )?.split(";")[0],
    ).toBe(
      "[0:0]hwmap,format=qsv,vpp_qsv=deinterlace=advanced:rate=frame:w=1920:h=1080:format=nv12,fps=source_fps,hwdownload,format=nv12[picture]",
    );
  });

  it("uploads frames the GPU cannot decode, in the source's bit depth", () => {
    const args = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "mpeg4",
      video: encode("vaapi", { codec: "mpeg4" }),
    });

    expect(args).not.toContain("-hwaccel");
    expect(after(args, "-vf")).toBe("format=nv12,hwupload,scale_vaapi=w=1920:h=1080:format=nv12");

    const qsv = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "mpeg4",
      video: encode("qsv", { codec: "mpeg4", bitDepth: 10 }),
    });

    expect(after(qsv, "-vf")).toBe(
      "format=p010le,hwupload=extra_hw_frames=64,format=qsv,vpp_qsv=w=1920:h=1080:format=nv12,fps=source_fps",
    );
  });

  it("tone-maps in software with zscale after scaling", () => {
    const args = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "hevc",
      video: encode("software", { codec: "hevc", bitDepth: 10, toneMap: true }),
    });

    expect(after(args, "-vf")).toBe(
      "scale=1920:1080:flags=bicubic,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,sidedata=mode=delete:type=DOVI_METADATA,sidedata=mode=delete:type=DOVI_RPU_BUFFER,format=yuv420p",
    );
    expect(after(args, "-c:v")).toBe("libx264");
  });

  it("draws a burned-in subtitle on the SDR picture at the output size, PGS at its height", () => {
    const software = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("software", { burnSubtitle: 3 }),
    });

    expect(software).not.toContain("-vf");
    expect(after(software, "-filter_complex")).toBe(
      [
        "[0:0]scale=1920:1080:flags=bicubic[picture]",
        `[0:3]${pgsOnCpu(1920, 1080)}[subtitle]`,
        "[picture][subtitle]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2:eof_action=pass:repeatlast=0,format=yuv420p[video]",
      ].join(";"),
    );
    expect(after(software, "-map")).toBe("[video]");

    // A DVD canvas shares the picture's pixel grid, so it is stretched over it, as before.
    expect(after(dvd(1.4), "-filter_complex")).toBe(
      [
        "[0:0]scale=1920:1080:flags=bicubic[picture]",
        "[0:3]scale=1920:1080[subtitle]",
        "[picture][subtitle]overlay=eof_action=pass:repeatlast=0,format=yuv420p[video]",
      ].join(";"),
    );
  });

  it("places a PGS canvas at a 2.39:1, 16:9, or 4:3 picture's height, its sides cut to fit", () => {
    // On a GPU row the canvas is held at its stated 1920x1080, never scaled up on the CPU, only
    // the middle a picture shows is uploaded, and the overlay scales and places it in even samples.
    // The CPU encodes a 4K picture at half its size.
    const sizes = [
      { width: 1126, height: 480, cpu: 1, cut: "", place: "x=136:y=0:w=852:h=480" },
      { width: 1920, height: 800, cpu: 1, cut: "", place: "x=248:y=0:w=1422:h=800" },
      { width: 1920, height: 804, cpu: 1, cut: "", place: "x=246:y=0:w=1428:h=804" },
      { width: 1920, height: 1080, cpu: 1, cut: "", place: "x=0:y=0:w=1920:h=1080" },
      { width: 1440, height: 1080, cpu: 1, cut: ",crop=1440:1080", place: "x=0:y=0:w=1440:h=1080" },
      { width: 3840, height: 1608, cpu: 2, cut: "", place: "x=490:y=0:w=2858:h=1608" },
      { width: 3840, height: 2160, cpu: 2, cut: "", place: "x=0:y=0:w=3840:h=2160" },
      { width: 2880, height: 2160, cpu: 2, cut: ",crop=1440:1080", place: "x=0:y=0:w=2880:h=2160" },
    ] as const;

    for (const size of sizes) {
      const graph = (domain: "qsv" | "vaapi" | "software") =>
        after(
          hlsCommandArgs({
            ...command(AudioPlan.Copy({ index: 1 }), "aac"),
            video: encode(domain, { burnSubtitle: 3, size }),
          }),
          "-filter_complex",
        );

      const uploaded = `[0:3]scale=1920:1080${size.cut},format=bgra,hwupload[subtitle]`;

      expect(graph("software")).toContain(
        `[0:3]${pgsOnCpu(size.width / size.cpu, size.height / size.cpu)}[subtitle]`,
      );
      expect(graph("qsv")).toContain(uploaded);
      expect(graph("qsv")).toContain(`overlay_qsv=${size.place}:`);
      expect(graph("vaapi")).toContain(uploaded);
      expect(graph("vaapi")).toContain(`overlay_vaapi=${size.place}:`);
    }
  });

  it("states no canvas for DVB or XSUB, and scales either to the picture before anything else", () => {
    for (const subtitleCodec of ["dvb_subtitle", "xsub"]) {
      const graph = (domain: "qsv" | "vaapi" | "software") => {
        const args = hlsCommandArgs({
          ...command(AudioPlan.Copy({ index: 1 }), "aac"),
          video: encode(domain, { burnSubtitle: 3, subtitleCodec }),
        });

        expect(args, subtitleCodec).not.toContain("-canvas_size");

        return after(args, "-filter_complex");
      };

      expect(graph("software")).toContain("[0:3]scale=1920:1080[subtitle]");
      expect(graph("qsv")).toContain("[0:3]scale=1920:1080,format=bgra,hwupload[subtitle]");
      expect(graph("qsv")).toContain("overlay_qsv=w=main_w:h=main_h:");
      expect(graph("vaapi")).toContain("[0:3]scale=1920:1080,format=bgra,hwupload[subtitle]");

      // A GPU row uploads it on 1920x1080 over any taller picture, and on 720x576 over one of 576
      // rows or fewer: never on a size taken from the picture.
      for (const [size, uploaded] of [
        [{ width: 3840, height: 1600 }, "1920:1080"],
        [{ width: 1126, height: 480 }, "720:576"],
        [{ width: 854, height: 480 }, "720:576"],
        [{ width: 1920, height: 804 }, "1920:1080"],
      ] as const) {
        const onVaapi = after(
          hlsCommandArgs({
            ...command(AudioPlan.Copy({ index: 1 }), "aac"),
            video: encode("vaapi", { burnSubtitle: 3, subtitleCodec, size }),
          }),
          "-filter_complex",
        );

        expect(onVaapi).toContain(`[0:3]scale=${uploaded},format=bgra,hwupload[subtitle]`);
        expect(onVaapi).toContain("overlay_vaapi=w=main_w:h=main_h:");
      }
    }
  });

  it("draws an image subtitle on the GPU, its canvas decoded on the CPU and uploaded", () => {
    const vaapi = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "hevc",
      video: encode("vaapi", { codec: "hevc", bitDepth: 10, burnSubtitle: 3, toneMap: true }),
    });

    expect(vaapi).toContain("-hwaccel");
    expect(after(vaapi, "-filter_complex")).toBe(
      [
        "[0:0]scale_vaapi=w=1920:h=1080:format=p010,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,sidedata=mode=delete:type=DOVI_METADATA,sidedata=mode=delete:type=DOVI_RPU_BUFFER,setparams=color_primaries=unknown[picture]",
        "[0:3]scale=1920:1080,format=bgra,hwupload[subtitle]",
        "[picture][subtitle]overlay_vaapi=x=0:y=0:w=1920:h=1080:eof_action=pass:repeatlast=0,setparams=color_primaries=bt709[video]",
      ].join(";"),
    );

    const qsv = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("qsv", { burnSubtitle: 3, subtitleCodec: "dvd_subtitle" }),
    });

    expect(after(qsv, "-filter_complex")).toBe(
      [
        "[0:0]hwmap,format=qsv,vpp_qsv=w=1920:h=1080:format=nv12[picture]",
        "[0:3]scale=720:576,format=bgra,hwupload[subtitle]",
        "[picture][subtitle]overlay_qsv=w=main_w:h=main_h:eof_action=pass:repeatlast=0,fps=source_fps[video]",
      ].join(";"),
    );
  });

  it("draws an image subtitle on the CPU between transfers where the GPU overlay is kept off", () => {
    const vaapi = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "hevc",
      video: encode("vaapi", {
        codec: "hevc",
        bitDepth: 10,
        burnSubtitle: 3,
        toneMap: true,
        without: ["burn-image.vaapi"],
      }),
    });

    expect(after(vaapi, "-filter_complex")).toBe(
      [
        "[0:0]scale_vaapi=w=1920:h=1080:format=p010,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,sidedata=mode=delete:type=DOVI_METADATA,sidedata=mode=delete:type=DOVI_RPU_BUFFER,hwdownload,format=nv12[picture]",
        `[0:3]${pgsOnCpu(1920, 1080)}[subtitle]`,
        "[picture][subtitle]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2:eof_action=pass:repeatlast=0,format=nv12,hwupload[video]",
      ].join(";"),
    );

    const qsv = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("qsv", {
        burnSubtitle: 3,
        subtitleCodec: "dvd_subtitle",
        without: ["burn-image.qsv"],
      }),
    });

    expect(after(qsv, "-filter_complex")).toBe(
      [
        "[0:0]hwmap,format=qsv,vpp_qsv=w=1920:h=1080:format=nv12,fps=source_fps,hwdownload,format=nv12[picture]",
        "[0:3]scale=1920:1080[subtitle]",
        "[picture][subtitle]overlay=eof_action=pass:repeatlast=0,format=nv12,hwupload=extra_hw_frames=64,format=qsv[video]",
      ].join(";"),
    );
  });

  it("draws a text subtitle with libass from the files the run names, plain text in one style", () => {
    const files = { subtitle: "/tmp/stream/a b/subtitle.ass", fonts: "/tmp/stream/a b/fonts" };

    const styled = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("software", { burnText: "styled" }),
      files,
    });

    expect(after(styled, "-vf")).toBe(
      "scale=1920:1080:flags=bicubic,subtitles=filename=/tmp/stream/a\\\\\\ b/subtitle.ass:fontsdir=/tmp/stream/a\\\\\\ b/fonts:original_size=1920x1080,format=yuv420p",
    );
    // libass holds the whole script, so a seek reads the file once, from the seek.
    expect(styled).not.toContain("-canvas_size");

    const plain = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("software", { burnText: "plain" }),
      files: { subtitle: files.subtitle },
    });

    expect(after(plain, "-vf")).toContain(
      "subtitles=filename=/tmp/stream/a\\\\\\ b/subtitle.ass:original_size=1920x1080:force_style=FontName=DejaVu\\\\\\ Sans\\,FontSize=18\\,",
    );

    const qsv = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("qsv", { burnText: "styled" }),
      files,
    });

    expect(after(qsv, "-vf")).toMatch(
      /^hwmap,format=qsv,vpp_qsv=w=1920:h=1080:format=nv12,fps=source_fps,hwdownload,format=nv12,subtitles=filename=.*,format=nv12,hwupload=extra_hw_frames=64,format=qsv$/u,
    );
    expect(() =>
      hlsCommandArgs({
        ...command(AudioPlan.Copy({ index: 1 }), "aac"),
        video: encode("software", { burnText: "styled" }),
      }),
    ).toThrow("A text subtitle is drawn only from the ASS file its run names");
  });

  it("reads a burned-in DVD subtitle on its canvas, once from the start", () => {
    const fromStart = dvd(1.4);

    expect(fromStart.slice(fromStart.indexOf("-canvas_size"), fromStart.indexOf("-map"))).toEqual([
      "-canvas_size",
      "720x576",
      "-copyts",
      "-i",
      "/media/Film (2021).ts",
      "-filter_complex",
      expect.stringContaining("[0:3]scale=1920:1080[subtitle]"),
    ]);
    expect(after(fromStart, "-filter_complex")).not.toContain("trim");
  });

  it("reads picture and subtitle together from earlier after a seek, and audio at the seek", () => {
    const seeked = dvd(61.4);

    expect(inputs(seeked)).toStrictEqual([
      "-canvas_size",
      "720x576",
      "-ss",
      "30.000000",
      "-copyts",
      "-i",
      "/media/Film (2021).ts",
      "-ss",
      "60.000000",
      "-copyts",
      "-i",
      "/media/Film (2021).ts",
    ]);
    expect(after(seeked, "-filter_complex")).toBe(
      [
        "[0:0]trim=start=61.400000,scale=1920:1080:flags=bicubic[picture]",
        "[0:3]trim=start=60.400000,scale=1920:1080[subtitle]",
        "[picture][subtitle]overlay=eof_action=pass:repeatlast=0,format=yuv420p[video]",
      ].join(";"),
    );
    expect(after(seeked, "-map")).toBe("[video]");
    expect(seeked.slice(seeked.lastIndexOf("-map"), seeked.indexOf("-map_metadata"))).toStrictEqual(
      ["-map", "1:1", "-c:a", "copy", "-bsf:a", "aac_adtstoasc"],
    );
  });

  it("reads from the file's start when a seek lands within the subtitle lead", () => {
    expect(inputs(dvd(21.4))).toStrictEqual([
      "-canvas_size",
      "720x576",
      "-copyts",
      "-i",
      "/media/Film (2021).ts",
      "-ss",
      "20.000000",
      "-copyts",
      "-i",
      "/media/Film (2021).ts",
    ]);
  });

  it("adds no reading for a seek that burns a subtitle into a film without audio", () => {
    const args = hlsCommandArgs({
      ...command(AudioPlan.None(), ""),
      from: 61.4,
      video: encode("software", { burnSubtitle: 3 }),
    });

    expect(inputs(args)).toStrictEqual([
      "-canvas_size",
      "1920x1080",
      "-ss",
      "30.000000",
      "-copyts",
      "-i",
      "/media/Film (2021).ts",
    ]);
    expect(args).toContain("-an");
  });

  it("keeps a converted track's timing on its own reading after a seek", () => {
    const burned = hlsCommandArgs({
      ...command(AudioPlan.Aac({ index: 1 }), "ac3"),
      from: 61.4,
      video: encode("software", { burnSubtitle: 3 }),
    });

    const plain = hlsCommandArgs({
      ...command(AudioPlan.Aac({ index: 1 }), "ac3"),
      from: 61.4,
      video: encode("software", {}),
    });

    expect(burned.slice(burned.lastIndexOf("-map"), burned.indexOf("-map_metadata"))).toStrictEqual(
      audioPart(plain).map((arg) => (arg === "0:1" ? "1:1" : arg)),
    );
    expect(inputs(burned).slice(inputs(burned).indexOf("-i") + 2, -2)).toStrictEqual(
      inputs(plain).slice(0, -2),
    );
  });

  it("keeps hardware decoding on the reading the graph trims, before any frame is processed", () => {
    const vaapi = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      from: 61.4,
      videoCodec: "hevc",
      video: encode("vaapi", {
        codec: "hevc",
        bitDepth: 10,
        burnSubtitle: 3,
        subtitleCodec: "dvd_subtitle",
        toneMap: true,
      }),
    });

    expect(vaapi.indexOf("-hwaccel")).toBeLessThan(vaapi.indexOf("-i"));
    expect(vaapi.indexOf("-canvas_size")).toBeLessThan(vaapi.indexOf("-i"));
    expect(after(vaapi, "-filter_complex")).toContain(
      "[0:0]trim=start=61.400000,scale_vaapi=w=1920:h=1080:format=p010,tonemap_vaapi=",
    );

    const qsv = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      from: 61.4,
      video: encode("qsv", { burnSubtitle: 3 }),
    });

    expect(qsv.indexOf("-hwaccel")).toBeLessThan(qsv.indexOf("-i"));
    expect(after(qsv, "-filter_complex")).toContain(
      "[0:0]trim=start=61.400000,hwmap,format=qsv,vpp_qsv=",
    );
  });

  it("never lets a seek read a burned-in subtitle apart from its picture", () => {
    const films = [1.4, 2, 21.4, 31.4, 31.402, 61.4, 3601.4].flatMap((from) =>
      [AudioPlan.None(), AudioPlan.Copy({ index: 1 }), AudioPlan.Aac({ index: 1 })].flatMap(
        (audio) =>
          (["software", "vaapi", "qsv"] as const).map((encoder) =>
            hlsCommandArgs({
              ...command(audio, "aac"),
              from,
              video: encode(encoder, { burnSubtitle: 3, subtitleCodec: "dvd_subtitle" }),
            }),
          ),
      ),
    );

    for (const args of films) {
      expect(after(args, "-filter_complex")).toContain("[0:0]");
      expect(after(args, "-filter_complex")).toContain("[0:3]");
      expect(after(args, "-filter_complex")).not.toMatch(/\[[1-9]:/u);
    }
  });

  it.each<readonly [OutputCodec, "software" | "qsv" | "vaapi", ReadonlyArray<string>]>([
    [
      "h264",
      "software",
      [
        "libx264",
        "-preset",
        "veryfast",
        "-profile:v",
        "high",
        "-crf",
        "23",
        "-maxrate",
        "8000000",
        "-bufsize",
        "16000000",
      ],
    ],
    [
      "hevc",
      "software",
      [
        "libx265",
        "-preset",
        "superfast",
        "-profile:v",
        "main",
        "-crf",
        "23",
        "-maxrate",
        "6000000",
        "-bufsize",
        "12000000",
        "-forced-idr",
        "1",
        "-x265-params",
        "log-level=error:open-gop=0",
        "-tag:v",
        "hvc1",
      ],
    ],
    [
      "av1",
      "software",
      [
        "libsvtav1",
        "-preset",
        "9",
        "-crf",
        "30",
        "-maxrate",
        "5200000",
        "-bufsize",
        "10400000",
        "-svtav1-params",
        "lp=3:hierarchical-levels=3:lookahead=0",
      ],
    ],
    [
      "h264",
      "qsv",
      [
        "h264_qsv",
        "-preset",
        "veryfast",
        "-b:v",
        "8000000",
        "-maxrate",
        "8000000",
        "-bufsize",
        "16000000",
        "-forced_idr",
        "1",
      ],
    ],
    [
      "hevc",
      "qsv",
      [
        "hevc_qsv",
        "-preset",
        "veryfast",
        "-profile:v",
        "main",
        "-b:v",
        "6000000",
        "-maxrate",
        "6000000",
        "-bufsize",
        "12000000",
        "-forced_idr",
        "1",
        "-tag:v",
        "hvc1",
      ],
    ],
    [
      "av1",
      "qsv",
      [
        "av1_qsv",
        "-preset",
        "veryfast",
        "-profile:v",
        "main",
        "-b:v",
        "5200000",
        "-maxrate",
        "5200000",
        "-bufsize",
        "10400000",
        "-forced_idr",
        "1",
      ],
    ],
    [
      "h264",
      "vaapi",
      [
        "h264_vaapi",
        "-profile:v",
        "high",
        "-b:v",
        "8000000",
        "-maxrate",
        "8000000",
        "-bufsize",
        "16000000",
      ],
    ],
    [
      "hevc",
      "vaapi",
      [
        "hevc_vaapi",
        "-profile:v",
        "main",
        "-b:v",
        "6000000",
        "-maxrate",
        "6000000",
        "-bufsize",
        "12000000",
        "-tag:v",
        "hvc1",
      ],
    ],
    [
      "av1",
      "vaapi",
      [
        "av1_vaapi",
        "-profile:v",
        "main",
        "-b:v",
        "5200000",
        "-maxrate",
        "5200000",
        "-bufsize",
        "10400000",
      ],
    ],
  ])(
    "encodes %s on %s with its rate control and sample entry, keyframes at the planned starts",
    (output, domain, encoder) => {
      const args = hlsCommandArgs({
        ...command(AudioPlan.Copy({ index: 1 }), "aac"),
        video: encode(domain, { output }),
      });

      expect(
        args.slice(args.indexOf("-c:v"), args.indexOf("-map", args.indexOf("-c:v"))),
      ).toStrictEqual(["-c:v", ...encoder, "-force_key_frames", "1.400000,3.400000"]);
    },
  );

  it.each<readonly [OutputCodec, "software" | "qsv" | "vaapi", number, ReadonlyArray<string>]>([
    ["hevc", "software", 153, ["-x265-params", "log-level=error:open-gop=0:level-idc=41"]],
    ["av1", "software", 19, ["-svtav1-params", "lp=3:hierarchical-levels=3:lookahead=0:level=41"]],
    ["hevc", "qsv", 153, ["-level", "41"]],
    ["av1", "qsv", 19, ["-level", "41"]],
    ["hevc", "vaapi", 153, ["-level", "123"]],
    ["av1", "vaapi", 19, ["-level", "9"]],
  ])(
    "states the level a %s encode on %s holds as its encoder takes it, under the client's %i",
    (output, domain, declared, stated) => {
      // 1080p at 60 frames a second, as an unknown frame rate counts, needs level 4.1 of both.
      const args = hlsCommandArgs({
        ...command(AudioPlan.Copy({ index: 1 }), "aac"),
        video: encode(domain, { output, level: declared }),
      });

      const encoder = args.slice(args.indexOf("-c:v"), args.indexOf("-force_key_frames"));
      const at = encoder.indexOf(stated[0] ?? "");

      expect(encoder.slice(at, at + stated.length)).toStrictEqual(stated);
    },
  );

  it("changes no other run", () => {
    const expected = [
      "-hide_banner",
      "-nostdin",
      "-nostats",
      "-v",
      "error",
      "-ss",
      "60.000000",
      "-copyts",
      "-i",
      "/media/Film (2021).ts",
      "-map",
      "0:0",
      "-vf",
      "scale=1920:1080:flags=bicubic,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-profile:v",
      "high",
      "-crf",
      "23",
      "-maxrate",
      "8000000",
      "-bufsize",
      "16000000",
      "-force_key_frames",
      "1.400000,3.400000",
      "-map",
      "0:1",
      "-af",
      "aresample=48000,aresample=async=1:min_hard_comp=0.02:first_pts=2947072",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-b:a",
      "192k",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-sn",
      "-dn",
      "-max_muxing_queue_size",
      "4096",
      "-avoid_negative_ts",
      "disabled",
      "-f",
      "hls",
      "-hls_time",
      "0.1",
      "-hls_list_size",
      "0",
      "-hls_playlist_type",
      "event",
      "-hls_segment_type",
      "fmp4",
      "-hls_flags",
      "temp_file",
      "-hls_fmp4_init_filename",
      "init.mp4",
      "-hls_segment_options",
      "movflags=+frag_discont",
      "-start_number",
      "0",
      "-hls_segment_filename",
      "/tmp/stream/1/f%d.m4s",
      "/tmp/stream/1/ffmpeg.m3u8",
    ];

    expect(
      hlsCommandArgs({
        ...command(AudioPlan.Aac({ index: 1 }), "ac3"),
        from: 61.4,
        video: encode("software", {}),
      }),
    ).toStrictEqual(expected);
  });
});

const mp4 = (video: VideoPlan) =>
  mp4CommandArgs({
    input: "/media/Film (2021).mkv",
    videoIndex: 0,
    videoCodec: "hevc",
    video,
    audio: AudioPlan.Aac({ index: 2 }),
    audioCodec: "dts",
    output: "/tmp/downloads/f/key.mp4.part",
    progress: "/tmp/downloads/f/key.mp4.progress",
  });

describe("mp4CommandArgs", () => {
  it("copies the whole file into an MP4 with its index first, from the start", () => {
    const args = mp4(VideoPlan.Copy({ dolbyVision: "none" }));

    expect(args).not.toContain("-ss");
    expect(args).not.toContain("-copyts");
    expect(args).not.toContain("-force_key_frames");
    expect(after(args, "-tag:v")).toBe("hvc1");
    expect(after(args, "-movflags")).toBe("+faststart");
    expect(after(args, "-progress")).toBe("/tmp/downloads/f/key.mp4.progress");
    expect(args.slice(-4)).toStrictEqual(["-f", "mp4", "-y", "/tmp/downloads/f/key.mp4.part"]);
  });

  it("writes an HEVC encode with the hvc1 sample entry, and H.264 and AV1 with their own", () => {
    expect(after(mp4(encode("qsv", { output: "hevc" })), "-tag:v")).toBe("hvc1");
    expect(mp4(encode("qsv", { output: "av1" }))).not.toContain("-tag:v");
    expect(mp4(encode("software", {}))).not.toContain("-tag:v");
  });

  it("encodes in software without a segment plan", () => {
    const args = mp4(encode("software", {}));

    expect(after(args, "-c:v")).toBe("libx264");
    expect(after(args, "-vf")).toBe("scale=1920:1080:flags=bicubic,format=yuv420p");
    expect(args).not.toContain("-force_key_frames");
    expect(after(args, "-c:a")).toBe("aac");
    expect(after(args, "-map")).toBe("0:0");
    expect(args.slice(args.lastIndexOf("-map"), args.lastIndexOf("-map") + 2)).toStrictEqual([
      "-map",
      "0:2",
    ]);
  });
});

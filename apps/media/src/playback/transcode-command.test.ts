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
import { type OutputCodec, sdrTarget, type SourceVideo } from "./video-ops.ts";

const hlsCommandArgs = (command: HlsCommand): ReadonlyArray<string> => hlsCommand(command).args;

const command = (audio: AudioPlan, audioCodec: string): HlsCommand => ({
  input: "/media/Film (2021).ts",
  sourceStart: 1.4,
  from: 1.4,
  videoIndex: 0,
  videoCodec: "h264",
  video: VideoPlan.Copy(),
  audio,
  audioCodec,
  copiedAudioEnd: undefined,
  segmentStarts: [1.4, 3.4],
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
  readonly burnSubtitle?: number;
  readonly subtitleCodec?: string;
  readonly device?: string;
}

const DEVICES = { qsv: "/dev/dri/renderD128", vaapi: "/dev/dri/renderD129" } as const;

/**
 * The plan a 1920x1080 source gets on `domain` (and the CPU) when the device verified everything:
 * an 8 Mbit/s H.264 encode at its size, or `output` at its share of that, tone-mapped from HDR10
 * when asked.
 */
const encode = (domain: "qsv" | "vaapi" | "software", options: EncodeOptions) => {
  const depth = options.bitDepth ?? 8;
  const toneMap = options.toneMap ?? false;

  const source: SourceVideo = {
    codec: options.codec ?? "h264",
    pixelFormat: depth > 8 ? "yuv420p10le" : "yuv420p",
    depth,
    colour: toneMap ? "hdr10" : "sdr",
    scan: "progressive",
    width: 1920,
    height: 1080,
  };

  const intent: VideoIntent = {
    targets: [{ ...sdrTarget(options.output ?? "h264"), level: options.level }],
    frameRate: undefined,
    bounds: { width: 1920, height: 1080 },
    cpuEncodeBounds: { width: 1920, height: 1080 },
    maxBitrate: undefined,
    burnImage:
      options.burnSubtitle === undefined
        ? undefined
        : {
            input: 0,
            stream: options.burnSubtitle,
            codec: options.subtitleCodec ?? "hdmv_pgs_subtitle",
            frame: {
              memory: "cpu",
              device: undefined,
              colour: "sdr",
              depth: 8,
              pixelFormat: "pal8",
              scan: "progressive",
              width: 1920,
              height: 1080,
            },
          },
  };

  const domains: ReadonlyArray<DomainBinding> =
    domain === "software" ? [] : [{ domain, device: options.device ?? DEVICES[domain] }];

  const keys = candidateKeys(source, intent, { domains, verified: new Set(), excluded: new Set() });

  const planned = planVideo(source, intent, {
    domains,
    verified: new Set(keys.keys()),
    excluded: new Set(),
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

const after = (args: ReadonlyArray<string>, flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

const inputs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.slice(
    args.findIndex((arg) => ["-canvas_size", "-ss", "-copyts"].includes(arg)),
    args.lastIndexOf("-i") + 2,
  );

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
    expect(after(args, "-vf")).toBe("hwmap,format=qsv,vpp_qsv=w=1920:h=1080:format=nv12");
    expect(after(args, "-c:v")).toBe("h264_qsv");
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
      "scale_vaapi=w=1920:h=1080:format=p010,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709",
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
          "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
          "sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA",
          "sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL",
        ].join(","),
      );
    },
  );

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
      "format=p010le,hwupload=extra_hw_frames=64,format=qsv,vpp_qsv=w=1920:h=1080:format=nv12",
    );
  });

  it("tone-maps in software with zscale after scaling", () => {
    const args = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "hevc",
      video: encode("software", { codec: "hevc", bitDepth: 10, toneMap: true }),
    });

    expect(after(args, "-vf")).toBe(
      "scale=1920:1080:flags=bicubic,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p",
    );
    expect(after(args, "-c:v")).toBe("libx264");
  });

  it("draws a burned-in subtitle on the SDR picture at the output size, on a GPU between transfers", () => {
    const software = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("software", { burnSubtitle: 3 }),
    });

    expect(software).not.toContain("-vf");
    expect(after(software, "-filter_complex")).toBe(
      [
        "[0:0]scale=1920:1080:flags=bicubic[picture]",
        "[0:3]scale=1920:1080[subtitle]",
        "[picture][subtitle]overlay=eof_action=pass:repeatlast=0,format=yuv420p[video]",
      ].join(";"),
    );
    expect(after(software, "-map")).toBe("[video]");

    const vaapi = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "hevc",
      video: encode("vaapi", { codec: "hevc", bitDepth: 10, burnSubtitle: 3, toneMap: true }),
    });

    expect(vaapi).toContain("-hwaccel");
    expect(after(vaapi, "-filter_complex")).toBe(
      [
        "[0:0]scale_vaapi=w=1920:h=1080:format=p010,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709,hwdownload,format=nv12[picture]",
        "[0:3]scale=1920:1080[subtitle]",
        "[picture][subtitle]overlay=eof_action=pass:repeatlast=0,format=nv12,hwupload[video]",
      ].join(";"),
    );

    const qsv = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("qsv", { burnSubtitle: 3 }),
    });

    expect(after(qsv, "-filter_complex")).toBe(
      [
        "[0:0]hwmap,format=qsv,vpp_qsv=w=1920:h=1080:format=nv12,hwdownload,format=nv12[picture]",
        "[0:3]scale=1920:1080[subtitle]",
        "[picture][subtitle]overlay=eof_action=pass:repeatlast=0,format=nv12,hwupload=extra_hw_frames=64,format=qsv[video]",
      ].join(";"),
    );
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
        "-max_interleave_delta",
        "0",
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
    ["av1", "software", 19, ["-svtav1-params", "level=41"]],
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
    const args = mp4(VideoPlan.Copy());

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

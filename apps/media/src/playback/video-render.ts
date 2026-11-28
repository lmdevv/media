/**
 * Renders a pipeline as ffmpeg's video arguments: the device its GPU domain opens, the decoder's
 * input flags, one filter graph, and the encoder. Adjacent calls of one filter that fuse become
 * one (`vpp_qsv` scaling and tone mapping). After the last filter of a domain whose filters leave
 * durations untrusted (Quick Sync's), the graph restates the frame rate once. An image subtitle
 * splits the graph in three chains: the picture up to the overlay, the subtitle, and the overlay
 * with what follows it. A text subtitle is one filter of the picture's chain, reading the files the
 * run names. Every value is escaped by `filterValue` as it is written, so a path or style may hold
 * any character. ffmpeg names each filter `Parsed_<filter>_<n>`, counting through the graph's
 * text, and the rendering records which steps own each name, so a failed run's log reads back to
 * steps.
 */
import { Predicate, type Types } from "effect";

import type { LogOwners } from "./transcode-recovery.ts";
import {
  DOMAINS,
  isAssembled,
  leavesUntrustedDurations,
  ProbeInput,
  RATE_FILTER,
  rowOf,
  type Step,
  type VideoPipeline,
} from "./video-pipeline.ts";
import { PROBE_CANVAS } from "./probe-clips.ts";
import {
  type FilterCall,
  filter,
  type GpuDomain,
  Op,
  type OptionValue,
  type Rendering,
  type RunFile,
} from "./video-ops.ts";

/** The paths of the files a run names for its filters; one it does not name is left out. */
export type RunFiles = Readonly<Partial<Record<RunFile, string>>>;

/** A filter graph: one chain for `-vf`, or several for `-filter_complex`. */
interface FilterGraph {
  readonly kind: "simple" | "complex";
  readonly text: string;
}

/** A pipeline's part of an ffmpeg run. */
export interface RenderedVideo {
  /** Before the input: the device and the decoder's flags. */
  readonly input: ReadonlyArray<string>;
  readonly graph: FilterGraph | undefined;
  /** After the graph: the encoder and its options. */
  readonly output: ReadonlyArray<string>;
  readonly owners: LogOwners;
}

/** Where a run reads the picture from, and what it drops after a seek. */
export interface RenderOptions {
  readonly input: number;
  readonly stream: number;
  /** Picture frames before this time only configure the graph; they are dropped first. */
  readonly trimPicture: number | undefined;
  /** Subtitle frames before this time are dropped. */
  readonly trimSubtitle: number | undefined;
  /** The files this run's filters read: a text subtitle's ASS file and its fonts. */
  readonly files: RunFiles;
}

interface Owned {
  readonly call: FilterCall;
  readonly steps: ReadonlyArray<number>;
}

const seconds = (value: number): string => value.toFixed(6);

/** Backslash-escapes each character of `value` that is in `special`. */
const escaped = (value: string, special: RegExp): string =>
  value.replaceAll(special, (character) => `\\${character}`);

/** What separates options (`:`) or quotes them, and whitespace, which ffmpeg trims at the ends. */
const OPTION_SPECIAL = /[\\':\s]/gu;

/** What separates filters, chains, and link labels in a graph, besides quotes and whitespace. */
const GRAPH_SPECIAL = /[\\'[\],;\s]/gu;

/**
 * `value` as one option value inside a filter graph: escaped once for the filter's option parser
 * and once more for the graph's, as ffmpeg reads both, so quotes, colons, commas, brackets,
 * semicolons, backslashes, spaces, and newlines in a path or a style reach the filter as they are.
 * Plain values, digits and words, come out unchanged.
 */
export const filterValue = (value: string): string =>
  escaped(escaped(value, OPTION_SPECIAL), GRAPH_SPECIAL);

/** A named option as `key=value`, or nothing when its value is a file the run does not name. */
const optionText = (key: string, value: OptionValue, files: RunFiles): ReadonlyArray<string> => {
  const text = Predicate.isString(value) ? value : files[value.file];

  return text === undefined ? [] : [`${key}=${filterValue(text)}`];
};

const textOf = (call: FilterCall, files: RunFiles): string => {
  const args = call.args.flatMap((arg) =>
    Predicate.isString(arg) ? [filterValue(arg)] : optionText(arg[0], arg[1], files),
  );

  return args.length === 0 ? call.name : `${call.name}=${args.join(":")}`;
};

/** Merges `next` into `last` when both are fusing calls of one filter. */
const fused = (last: Owned | undefined, next: Owned): Owned | undefined => {
  if (
    last === undefined ||
    last.call.fuses !== true ||
    next.call.fuses !== true ||
    last.call.name !== next.call.name
  ) {
    return undefined;
  }

  const args = [...last.call.args];

  for (const arg of next.call.args) {
    const at = Predicate.isString(arg)
      ? -1
      : args.findIndex((known) => !Predicate.isString(known) && known[0] === arg[0]);

    if (at === -1) args.push(arg);
    else args[at] = arg;
  }

  return { call: { ...last.call, args }, steps: [...last.steps, ...next.steps] };
};

const trim = (at: number | undefined): ReadonlyArray<Owned> =>
  at === undefined ? [] : [{ call: filter("trim", ["start", seconds(at)]), steps: [] }];

const callsOf = (steps: ReadonlyArray<Step>, offset: number): ReadonlyArray<Owned> =>
  steps
    .flatMap((step, index) =>
      step.rendering.filters.map((call): Owned => ({ call, steps: [offset + index] })),
    )
    .reduce<Array<Owned>>((calls, next) => {
      const merged = fused(calls.at(-1), next);

      if (merged === undefined) calls.push(next);
      else calls[calls.length - 1] = merged;

      return calls;
    }, []);

/**
 * Re-times frames at the rate of the frames reaching it, which is the rate the chain hands the
 * encoder at that point (a deinterlacer before it that doubles the rate doubles it), and gives each
 * a duration of one frame. It reads timestamps and the end of the stream, never durations, so it
 * makes whole what a domain's filters leave untrusted (`DomainSpec.filterDurations`): Quick Sync's
 * under ffmpeg 7.1.x, which copy durations in the input's time base (FFmpeg 578ac59887, in 7.1
 * through 7.1.5; 7.0.x copies them first, as 8.0 does again after bc991ca048). Left alone, ffmpeg's
 * constant-rate output holds a 24 fps MP4's first picture for 21 s and runs a variable-rate file's
 * last segment to 1127 s. It runs on every build: on ffmpeg 9.0.2 a constant-rate source's encode
 * comes out byte for byte the same, and a variable-rate file's ends at its last frame's end (960
 * frames for 16 s at 60 fps, as the CPU path gives) instead of a frame short. Once the image's
 * ffmpeg is 8 or later it can go.
 */
const RESTATE_RATE: FilterCall = filter(RATE_FILTER, "source_fps");

/** Whether `step` is a processing filter of a domain whose filters leave durations untrusted. */
const untrustedDurations = (step: Step | undefined): boolean =>
  step !== undefined && leavesUntrustedDurations(step.on, step.op, step.rendering);

/** Where in `calls` the last call is that a step with untrusted durations owns; -1 for none. */
const lastUntrusted = (calls: ReadonlyArray<Owned>, steps: ReadonlyArray<Step>): number =>
  calls.findLastIndex((owned) => owned.steps.some((index) => untrustedDurations(steps[index])));

/**
 * `calls` with the rate restated after their last call with untrusted durations, owned by that
 * call's steps; `calls` as they are when none has them.
 */
const restated = (
  calls: ReadonlyArray<Owned>,
  steps: ReadonlyArray<Step>,
): ReadonlyArray<Owned> => {
  const last = lastUntrusted(calls, steps);
  const after = calls[last];

  return after === undefined
    ? calls
    : [
        ...calls.slice(0, last + 1),
        { call: RESTATE_RATE, steps: after.steps },
        ...calls.slice(last + 1),
      ];
};

const namesOf = (step: Step, prefix: "decoder:" | "encoder:"): ReadonlyArray<string> =>
  step.needs.flatMap((need) => (need.startsWith(prefix) ? [need.slice(prefix.length)] : []));

/** Whether a step of `steps` runs on Vulkan, which a chain then opens on its domain's GPU. */
const onVulkan = (steps: ReadonlyArray<Step>): boolean =>
  steps.some((step) => rowOf(step.impl)?.transfers?.device === "vulkan");

/**
 * The GPU domain `steps` run on and its render node: the first step that runs on one, or the first
 * frame held in one.
 */
const domainOf = (
  steps: ReadonlyArray<Step>,
): { readonly domain: GpuDomain; readonly device: string } | undefined => {
  for (const step of steps) {
    if (step.on !== "cpu" && step.device !== undefined)
      return { domain: step.on, device: step.device };

    for (const frame of [step.input, step.output]) {
      if (frame.memory !== "cpu" && frame.device !== undefined) {
        return { domain: frame.memory, device: frame.device };
      }
    }
  }

  return undefined;
};

/**
 * The device arguments of `steps`: their domain's, with a Vulkan device derived from it when a
 * step runs on Vulkan (`DomainSpec.vulkanArgs`).
 */
const deviceArgs = (steps: ReadonlyArray<Step>): ReadonlyArray<string> => {
  const bound = domainOf(steps);

  if (bound === undefined) return [];

  return onVulkan(steps)
    ? DOMAINS[bound.domain].vulkanArgs(bound.device)
    : DOMAINS[bound.domain].deviceArgs(bound.device);
};

/**
 * `call` naming `domain`'s device where it would take the run's filter device, which is Vulkan in a
 * chain that runs a step there: an upload or a map that names no device of its own.
 */
const naming =
  (domain: GpuDomain) =>
  (call: FilterCall): FilterCall =>
    (call.name === "hwupload" || call.name === "hwmap") &&
    !call.args.some((arg) => !Predicate.isString(arg) && arg[0] === "derive_device")
      ? { ...call, args: [["derive_device", domain], ...call.args] }
      : call;

/**
 * `steps` with their uploads and maps naming their domain's device (`naming`) when a step runs on
 * Vulkan; otherwise as they are.
 */
const pinned = (steps: ReadonlyArray<Step>): ReadonlyArray<Step> => {
  const bound = domainOf(steps);

  if (bound === undefined || !onVulkan(steps)) return steps;
  const name = naming(bound.domain);

  return steps.map((step) => ({ ...step, rendering: renamed(step.rendering, name) }));
};

/** `rendering` with `name` applied to every filter call in it, its side's included. */
const renamed = (rendering: Rendering, name: (call: FilterCall) => FilterCall): Rendering => {
  const result: Types.Mutable<Rendering> = {
    ...rendering,
    filters: rendering.filters.map(name),
  };

  const { side } = rendering;

  if (side !== undefined) {
    const named: Types.Mutable<NonNullable<Rendering["side"]>> = {
      ...side,
      calls: side.calls.map(name),
    };

    if (side.picture !== undefined) named.picture = side.picture.map(name);

    result.side = named;
  }

  return result;
};

/**
 * Renders `pipeline` for one run. Only a pipeline `assemble` returned renders: anything else, a
 * copy with its steps changed for one, is a defect, as its moves and evidence went unchecked.
 */
export const renderVideo = (pipeline: VideoPipeline, options: RenderOptions): RenderedVideo => {
  if (!isAssembled(pipeline)) throw new Error("Only a pipeline assemble returned can be rendered");
  const steps = pinned(pipeline.steps);

  if (options.files.subtitle === undefined && steps.some((step) => Op.$is("BurnText")(step.op))) {
    throw new Error("A text subtitle is drawn only from the ASS file its run names");
  }

  const burn = steps.findIndex((step) => Op.$is("BurnImage")(step.op));
  const burnStep = steps[burn];
  const filters = new Map<string, ReadonlyArray<number>>();
  let parsed = 0;

  const chain = (calls: ReadonlyArray<Owned>): string =>
    calls
      .map(({ call, steps: owners }) => {
        filters.set(`Parsed_${call.name}_${String(parsed)}`, owners);
        parsed += 1;

        return textOf(call, options.files);
      })
      .join(",");

  let graph: FilterGraph | undefined;

  if (burnStep === undefined || burnStep.rendering.side === undefined) {
    const calls = restated(callsOf(steps, 0), steps);

    graph = calls.length === 0 ? undefined : { kind: "simple", text: chain(calls) };
  } else {
    const { side } = burnStep.rendering;
    const drawn = callsOf(steps.slice(burn), burn);

    const shown = [
      ...trim(options.trimPicture),
      ...callsOf(steps.slice(0, burn), 0),
      ...(side.picture ?? []).map((call): Owned => ({ call, steps: [burn] })),
    ];

    // The rate is restated once, in the overlay's chain when a filter there needs it.
    const [picture, overlay] =
      lastUntrusted(drawn, steps) === -1
        ? [restated(shown, steps), drawn]
        : [shown, restated(drawn, steps)];

    const subtitle = [
      ...trim(options.trimSubtitle),
      ...side.calls.map((call): Owned => ({ call, steps: [burn] })),
    ];

    graph = {
      kind: "complex",
      text: [
        `[${String(options.input)}:${String(options.stream)}]${chain(picture)}[picture]`,
        `[${String(side.input)}:${String(side.stream)}]${chain(subtitle)}[subtitle]`,
        `[picture][subtitle]${chain(overlay)}[video]`,
      ].join(";"),
    };
  }

  const decoder = steps.findIndex((step) => Op.$is("Decode")(step.op));
  const encoder = steps.findIndex((step) => Op.$is("Encode")(step.op));
  const decodeStep = steps[decoder];
  const encodeStep = steps[encoder];

  return {
    input: [...deviceArgs(steps), ...steps.flatMap((step) => step.rendering.input)],
    graph,
    output: steps.flatMap((step) => step.rendering.output),
    owners: {
      decoder:
        decodeStep === undefined || !Op.$is("Decode")(decodeStep.op)
          ? undefined
          : { step: decoder, names: [decodeStep.op.codec, ...namesOf(decodeStep, "decoder:")] },
      encoder:
        encodeStep === undefined
          ? undefined
          : { step: encoder, names: namesOf(encodeStep, "encoder:") },
      filters,
    },
  };
};

/** The arguments that map the picture through `rendered`'s graph, or as it is without one. */
export const graphArgs = (
  rendered: RenderedVideo,
  options: Pick<RenderOptions, "input" | "stream">,
): ReadonlyArray<string> => {
  const picture = `${String(options.input)}:${String(options.stream)}`;

  if (rendered.graph === undefined) return ["-map", picture];

  return rendered.graph.kind === "simple"
    ? ["-map", picture, "-vf", rendered.graph.text]
    : ["-filter_complex", rendered.graph.text, "-map", "[video]"];
};

/** What a probe reads besides its clip, and where it writes the picture it reads back. */
export interface ProbeExtras {
  /** The files its filters read, such as the probe's own ASS script. */
  readonly files: RunFiles;
  /** Where its first output picture goes, in 8-bit gray, for a probe that reads one back. */
  readonly readback: string | undefined;
}

/**
 * The ffmpeg arguments that run `pipeline` reading `path`: the whole of a generated clip, or a real
 * source's first second of stream `stream`, into ffmpeg's null output, with progress on standard
 * output so the run's frame count can be read; a probe that reads its picture back writes its
 * first frame to `extras.readback` instead. An overlay reads `PROBE_CANVAS` as its subtitle.
 * Probes run this way.
 */
export const probeCommandArgs = (
  pipeline: VideoPipeline,
  input: ProbeInput,
  path: string,
  stream: number,
  extras: ProbeExtras = { files: {}, readback: undefined },
): ReadonlyArray<string> => {
  const options: RenderOptions = {
    input: 0,
    stream,
    trimPicture: undefined,
    trimSubtitle: undefined,
    files: extras.files,
  };

  const rendered = renderVideo(pipeline, options);

  const overlaid = pipeline.steps.some(
    (step) => step.rendering.side !== undefined && step.rendering.side.input > 0,
  );

  return [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-v",
    "error",
    "-progress",
    "pipe:1",
    ...rendered.input,
    ...ProbeInput.$match(input, { Clip: () => [], Source: () => ["-t", "1"] }),
    "-i",
    path,
    ...(overlaid ? ["-f", "lavfi", "-i", PROBE_CANVAS] : []),
    ...graphArgs(rendered, options),
    ...rendered.output,
    "-an",
    "-sn",
    "-dn",
    ...(extras.readback === undefined
      ? ["-f", "null", "-"]
      : ["-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-y", extras.readback]),
  ];
};

/** How many frames a probe's progress report says came out. */
export const probedFrames = (progress: string): number => {
  const counts = [...progress.matchAll(/^frame=(\d+)$/gmu)];

  return Number(counts.at(-1)?.[1] ?? 0);
};

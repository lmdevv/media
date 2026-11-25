/**
 * Renders a pipeline as ffmpeg's video arguments: the device its GPU domain opens, the decoder's
 * input flags, one filter graph, and the encoder. Adjacent calls of one filter that fuse become
 * one (`vpp_qsv` scaling and tone mapping). An image subtitle splits the graph in three chains:
 * the picture up to the overlay, the subtitle, and the overlay with what follows it. ffmpeg names
 * each filter `Parsed_<filter>_<n>`, counting through the graph's text, and the rendering records
 * which steps own each name, so a failed run's log reads back to steps.
 */
import { Predicate } from "effect";

import type { LogOwners } from "./transcode-recovery.ts";
import { DOMAINS, ProbeInput, type Step, type VideoPipeline } from "./video-pipeline.ts";
import { type FilterCall, filter, type GpuDomain, Op } from "./video-ops.ts";

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
}

interface Owned {
  readonly call: FilterCall;
  readonly steps: ReadonlyArray<number>;
}

const seconds = (value: number): string => value.toFixed(6);

const textOf = (call: FilterCall): string =>
  call.args.length === 0
    ? call.name
    : `${call.name}=${call.args
        .map((arg) => (Predicate.isString(arg) ? arg : `${arg[0]}=${arg[1]}`))
        .join(":")}`;

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

const namesOf = (step: Step, prefix: "decoder:" | "encoder:"): ReadonlyArray<string> =>
  step.needs.flatMap((need) => (need.startsWith(prefix) ? [need.slice(prefix.length)] : []));

const deviceArgs = (pipeline: VideoPipeline): ReadonlyArray<string> => {
  const frame = pipeline.steps
    .flatMap((step) => [step.input, step.output])
    .find((candidate) => candidate.memory !== "cpu" && candidate.device !== undefined);

  if (frame === undefined || frame.memory === "cpu" || frame.device === undefined) return [];
  const domain: GpuDomain = frame.memory;

  return DOMAINS[domain].deviceArgs(frame.device);
};

/** Renders `pipeline` for one run. */
export const renderVideo = (pipeline: VideoPipeline, options: RenderOptions): RenderedVideo => {
  const { steps } = pipeline;
  const burn = steps.findIndex((step) => Op.$is("BurnImage")(step.op));
  const burnStep = steps[burn];
  const filters = new Map<string, ReadonlyArray<number>>();
  let parsed = 0;

  const chain = (calls: ReadonlyArray<Owned>): string =>
    calls
      .map(({ call, steps: owners }) => {
        filters.set(`Parsed_${call.name}_${String(parsed)}`, owners);
        parsed += 1;

        return textOf(call);
      })
      .join(",");

  let graph: FilterGraph | undefined;

  if (burnStep === undefined || burnStep.rendering.side === undefined) {
    const calls = callsOf(steps, 0);

    graph = calls.length === 0 ? undefined : { kind: "simple", text: chain(calls) };
  } else {
    const { side } = burnStep.rendering;
    const picture = [...trim(options.trimPicture), ...callsOf(steps.slice(0, burn), 0)];

    const subtitle = [
      ...trim(options.trimSubtitle),
      ...side.calls.map((call): Owned => ({ call, steps: [burn] })),
    ];

    const overlay = callsOf(steps.slice(burn), burn);

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
    input: [...deviceArgs(pipeline), ...steps.flatMap((step) => step.rendering.input)],
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

/** A translucent white picture a probe of an overlay reads as its subtitle. */
const PROBE_SUBTITLE = "color=c=white@0.5:s=320x240:d=1,format=yuva420p";

/**
 * The ffmpeg arguments that run `pipeline` reading `path`: the whole of a generated clip, or a real
 * source's first second of stream `stream`, into ffmpeg's null output, with progress on standard
 * output so the run's frame count can be read. Probes run this way.
 */
export const probeCommandArgs = (
  pipeline: VideoPipeline,
  input: ProbeInput,
  path: string,
  stream: number,
): ReadonlyArray<string> => {
  const options: RenderOptions = {
    input: 0,
    stream,
    trimPicture: undefined,
    trimSubtitle: undefined,
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
    ...(overlaid ? ["-f", "lavfi", "-i", PROBE_SUBTITLE] : []),
    ...graphArgs(rendered, options),
    ...rendered.output,
    "-an",
    "-sn",
    "-dn",
    "-f",
    "null",
    "-",
  ];
};

/** How many frames a probe's progress report says came out. */
export const probedFrames = (progress: string): number => {
  const counts = [...progress.matchAll(/^frame=(\d+)$/gmu)];

  return Number(counts.at(-1)?.[1] ?? 0);
};

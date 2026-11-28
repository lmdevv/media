import type { MediaProbe } from "../media/media-probe.ts";
import {
  candidateKeys,
  type CapabilitySnapshot,
  type DomainBinding,
  sourceOf,
} from "../playback/video-pipeline.ts";
import {
  type Burn,
  type CapabilityKey,
  type GpuDomain,
  Op,
  OUTPUT_CODECS,
  sdrTarget,
} from "../playback/video-ops.ts";

/** The render node test snapshots bind every GPU domain to. */
const DEVICE = "/dev/dri/renderD128";

/**
 * A snapshot in which every key some chain for `probe`'s video could use on `domains` (and the
 * CPU) is verified, to any output codec, burning an image subtitle in or not, and a text one for a
 * file that has a text track, except the keys `refused`
 * picks: what planning may use on a test server whose devices do everything.
 */
export const verifiedFor = (
  probe: MediaProbe,
  domains: ReadonlyArray<GpuDomain> = [],
  refused: (key: CapabilityKey) => boolean = () => false,
): CapabilitySnapshot => {
  const bindings: ReadonlyArray<DomainBinding> = domains.map((domain) => ({
    domain,
    device: DEVICE,
  }));

  const bound: CapabilitySnapshot = { domains: bindings, verified: new Set(), excluded: new Set() };
  const video = probe.video;

  if (video === undefined) return bound;
  const source = sourceOf(video);

  const burns: ReadonlyArray<Burn | undefined> = [
    undefined,
    Op.BurnImage({
      subtitle: {
        input: 0,
        stream: 0,
        codec: "dvd_subtitle",
        frame: {
          memory: "cpu",
          device: undefined,
          colour: "sdr",
          depth: 8,
          pixelFormat: "pal8",
          scan: "progressive",
          width: source.width,
          height: source.height,
        },
      },
    }),
  ];

  // A text track's keys only for a file with one, as planning every burn costs each test.
  const burning: ReadonlyArray<Burn | undefined> = probe.subtitles.some(
    (track) => track.kind === "text",
  )
    ? [
        ...burns,
        Op.BurnText({
          subtitle: {
            codec: "ass",
            style: "styled",
            storage: { width: source.width, height: source.height },
          },
        }),
      ]
    : burns;

  const keys = burning.flatMap((burn) =>
    Array.from(
      candidateKeys(
        source,
        {
          targets: OUTPUT_CODECS.map(sdrTarget),
          frameRate: undefined,
          bounds: { width: source.width, height: source.height },
          cpuEncodeBounds: { width: 1920, height: 1080 },
          maxBitrate: undefined,
          burn,
        },
        bound,
      ).keys(),
    ),
  );

  return { ...bound, verified: new Set(keys.filter((key) => !refused(key))) };
};

/** Refuses every tone map: a build without `zscale` and devices that cannot tone-map. */
export const withoutToneMaps = (key: CapabilityKey): boolean => key.startsWith("tonemap.");

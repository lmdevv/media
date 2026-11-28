/** Frame colours tests build sources and frames from. */
import { type Colour, SDR_BT709, type Signal } from "../playback/video-ops.ts";

/** HDR10: PQ over BT.2020 with mastering display metadata. */
export const HDR10: Colour = {
  signal: "pq",
  transfer: "smpte2084",
  primaries: "bt2020",
  matrix: "bt2020nc",
  range: "limited",
  mastering: "present",
};

/** HLG over BT.2020, which carries no mastering display metadata. */
const HLG: Colour = { ...HDR10, signal: "hlg", transfer: "arib-std-b67", mastering: "absent" };

/** Dolby Vision 5's IPT-PQ-c2, which no tag states. */
export const DOLBY_VISION_IPT: Colour = {
  signal: "dovi",
  transfer: undefined,
  primaries: undefined,
  matrix: undefined,
  range: "limited",
  mastering: "absent",
};

const BY_SIGNAL: Readonly<Record<Signal, Colour>> = {
  sdr: SDR_BT709,
  pq: HDR10,
  hlg: HLG,
  dovi: DOLBY_VISION_IPT,
};

/** The colour tests use for frames of `signal`. */
export const colourOf = (signal: Signal): Colour => BY_SIGNAL[signal];

export { SDR_BT709 };

import { v } from "convex/values";
import type { Infer } from "convex/values";

/**
 * What the media server knows about transcoding on its machine, as it reports it: the ffmpeg
 * build, each GPU device as one GPU API sees it (its render node by name alone), and each
 * capability with its status, where and when its latest evidence came from, what it showed as a
 * code, and the end of any quarantine in force (`restart`: not before the server restarts).
 */
export const transcodingReport = v.object({
  build: v.union(
    v.null(),
    v.object({
      version: v.union(v.string(), v.null()),
      kernel: v.string(),
      checkedAt: v.number(),
    }),
  ),
  devices: v.array(
    v.object({
      domain: v.string(),
      node: v.string(),
      opened: v.boolean(),
      pci: v.union(v.string(), v.null()),
      kernelDriver: v.union(v.string(), v.null()),
      userDriver: v.union(v.string(), v.null()),
      checkedAt: v.number(),
    }),
  ),
  capabilities: v.array(
    v.object({
      key: v.string(),
      domain: v.string(),
      status: v.union(v.literal("unknown"), v.literal("verified"), v.literal("unsupported")),
      source: v.union(v.literal("listing"), v.literal("probe"), v.null()),
      checkedAt: v.union(v.number(), v.null()),
      reason: v.union(
        v.literal("listed"),
        v.literal("not-listed"),
        v.literal("passed"),
        v.literal("refused"),
        v.literal("crashed"),
        v.literal("inconclusive"),
        v.null(),
      ),
      quarantineEndsAt: v.union(v.number(), v.literal("restart"), v.null()),
    }),
  ),
});

/** What the media server knows about transcoding on its machine. */
export type TranscodingReport = Infer<typeof transcodingReport>;

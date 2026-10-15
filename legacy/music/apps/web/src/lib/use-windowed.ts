import { useEffect, useState } from "react";

import { scrollRootOf } from "./scroll-root";
import { useIsDesktop } from "./use-media";

/** How far past the visible part of the list a block stays rendered, as a share of its height. */
const WINDOW_MARGIN = "150% 0px";

/** Whether a block of a long list is rendered, and the height it keeps while it isn't. */
export interface Windowed {
  /** Attach to the block's wrapper. */
  readonly ref: (node: HTMLElement | null) => void;
  /** True while the block renders its rows: near the visible part of the list, or pinned. */
  readonly shown: boolean;
  /**
   * The height in pixels an empty block keeps: its last rendered height, or the estimate when it
   * hasn't rendered at this size and layout. Null until there is an estimate.
   */
  readonly height: number | null;
}

/** Options for {@link useWindowed}. */
export interface WindowedOptions {
  /**
   * Whether the block renders before the first intersection check. The blocks at the top of a list
   * do, so the list shows at once; blocks further down wait until they are near.
   */
  readonly initiallyNear?: boolean;
  /** Renders the block wherever it is, such as the one holding a dragged row. */
  readonly pinned?: boolean;
  /** The block's height before it has rendered: its row count times a row's height. */
  readonly estimate: number | null;
  /**
   * How many items the block holds. A measured height belongs to the count it was measured at; a
   * block whose rows changed while it was empty falls back to the estimate.
   */
  readonly size: number;
}

/**
 * A block's rendered height, how many items it held, and the layout it was measured in: rows are
 * taller in the desktop layout, so a height from the other side of the breakpoint is stale.
 */
interface Measured {
  readonly height: number;
  readonly size: number;
  readonly desktop: boolean;
}

/**
 * Windowing for a long list rendered in blocks of rows: a block far from the visible part of the
 * list renders an empty box of its height instead of its rows, so the page holds a few hundred
 * rows however long the list is, and the scrollbar stays put. A block is measured whenever its rows
 * are on the page, and an empty block never renders its rows just to measure them.
 */
export const useWindowed = ({
  initiallyNear = true,
  pinned = false,
  estimate,
  size,
}: WindowedOptions): Windowed => {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [near, setNear] = useState(initiallyNear);
  const [measured, setMeasured] = useState<Measured | null>(null);
  const desktop = useIsDesktop();
  const shown = near || pinned;

  useEffect(() => {
    if (node === null) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);

        if (entry !== undefined) setNear(entry.isIntersecting);
      },
      { root: scrollRootOf(node), rootMargin: WINDOW_MARGIN },
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [node]);

  // Measured only while the rows are there; an empty box keeps the last rendered height.
  useEffect(() => {
    if (node === null || !shown) return undefined;

    const observer = new ResizeObserver((entries) => {
      const blockSize = entries.at(-1)?.borderBoxSize[0]?.blockSize;

      if (blockSize !== undefined && blockSize > 0) {
        setMeasured({ height: blockSize, size, desktop });
      }
    });

    observer.observe(node);

    return () => observer.disconnect();
  }, [node, shown, size, desktop]);

  const current = measured !== null && measured.size === size && measured.desktop === desktop;

  return { ref: setNode, shown, height: current ? measured.height : estimate };
};

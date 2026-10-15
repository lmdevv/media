import { lazy, useState } from "react";
import type { ComponentType, ReactNode } from "react";

/** A lazily loaded component's code didn't load: offline, or the server was upgraded and the old chunk is gone. */
export class ChunkLoadError extends Error {
  override readonly name = "ChunkLoadError";
}

/** A component loaded on demand, and the function that loads its chunk ahead of time. */
export interface LazyChunk<Props extends object> {
  readonly Component: (props: Props) => ReactNode;
  readonly preload: () => Promise<void>;
}

/**
 * A component in a chunk of its own that renders straight away once the chunk is in. `React.lazy`
 * alone suspends on its first render even when the chunk has loaded, and React holds a revealed
 * boundary back for up to 300 ms. A failed load rejects with a {@link ChunkLoadError}, so a
 * boundary can tell it from a bug in the component, and the next mount tries again: `React.lazy`
 * keeps a failure for good, so a fresh one takes its place. Unlike TanStack's
 * `lazyRouteComponent`, nothing reloads the page, which would stop the music.
 */
export const lazyChunk = <Props extends object>(
  load: () => Promise<ComponentType<Props>>,
): LazyChunk<Props> => {
  // The loaded component, kept for the page's life like the module it comes from.
  let ready: ComponentType<Props> | null = null;

  const pending = () => lazy(async () => ({ default: await loadReady() }));

  let Pending = pending();

  const loadReady = async (): Promise<ComponentType<Props>> => {
    try {
      ready = await load();

      return ready;
    } catch (cause) {
      Pending = pending();

      throw new ChunkLoadError("A chunk of the app didn't load", { cause });
    }
  };

  return {
    Component: (props) => {
      // Chosen once per mount: switching from `Pending` to the loaded component later would be a
      // different element type, and React would remount it and lose its state.
      const [Shown] = useState(() => ready ?? Pending);

      return <Shown {...props} />;
    },
    preload: async () => {
      await loadReady();
    },
  };
};

import { usePlatform } from "@media/sdk/react";
import type { QueryState } from "@media/sdk/react";
import { useMemo, useState, useSyncExternalStore } from "react";

import { useAllPages } from "@media/mobile-core/pages";
import type { Paged, Watch } from "@media/mobile-core/pages";

import type { Library, LibraryDetail, Scan } from "@/lib/owner";
import { isActive } from "@/lib/scans";

/** A library that is scanning now, and its scan. */
export interface ActiveScan {
  readonly library: Library;
  readonly scan: Scan;
}

/** The movies libraries shared with this person, every page of them. */
export const useMovieLibraries = (): Paged<Library> => {
  const platform = usePlatform();

  const paged = useAllPages(platform.core.libraries.list, (paginationOpts) => ({
    paginationOpts,
  }));

  return useMemo(
    () =>
      paged.status === "ready"
        ? { ...paged, rows: paged.rows.filter((library) => library.kind === "movies") }
        : paged,
    [paged],
  );
};

interface Combined<A> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => ReadonlyArray<QueryState<A>>;
}

/** One store over several followed queries; its snapshot changes only when one of theirs does. */
const combine = <A>(watches: ReadonlyArray<Watch<A>>): Combined<A> => {
  let inputs: ReadonlyArray<QueryState<A>> = [];

  return {
    subscribe: (onChange) => {
      const stops = watches.map((watch) => watch.subscribe(onChange));

      return () => {
        for (const stop of stops) stop();
      };
    },
    getSnapshot: () => {
      const next = watches.map((watch) => watch.getSnapshot());

      if (next.length !== inputs.length || next.some((state, index) => state !== inputs[index])) {
        inputs = next;
      }

      return inputs;
    },
  };
};

/**
 * The scans running or queued now in `libraries`, each library's detail followed live, as the
 * movies web client's scan toast follows them. A household has a few libraries, so following each
 * one costs little.
 */
export const useActiveScans = (libraries: ReadonlyArray<Library>): ReadonlyArray<ActiveScan> => {
  const platform = usePlatform();
  const key = libraries.map((library) => library.libraryId).join(",");

  const open = (): Combined<LibraryDetail> =>
    combine(
      libraries.map((library) =>
        platform.core.libraries.get.watch({ libraryId: library.libraryId }),
      ),
    );

  // State rather than a memo: React may drop a memo, which would restart every subscription.
  const [held, setHeld] = useState(() => ({ platform, key, store: open() }));
  let current = held;

  if (held.platform !== platform || held.key !== key) {
    current = { platform, key, store: open() };
    setHeld(current);
  }

  const { store } = current;
  const states = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return useMemo(
    () =>
      libraries.flatMap((library, index): ReadonlyArray<ActiveScan> => {
        const state = states[index];
        const scan = state?.status === "success" ? state.data.scan : null;

        return scan !== null && isActive(scan) ? [{ library, scan }] : [];
      }),
    [libraries, states],
  );
};

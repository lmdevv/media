import { AlbumPage, ArtistPage, PageArgs, TrackPage } from "@music/commands/models";
import type { AlbumCard, ArtistCard, Track } from "@music/commands/models";
import type { QueryName } from "@music/commands/registry";
import { InvalidResultError } from "@music/sdk/client";
import { readCommand } from "@music/sdk/functions";
import { useQueries } from "convex/react";
import { Result, Schema } from "effect";
import { useMemo, useState } from "react";

import {
  FIRST_PAGE,
  extendChain,
  joinChain,
  keyOf,
  pageBounds,
  reconcileChain,
} from "@/lib/page-chain";
import type { ChainStatus, Cursors, PageResult } from "@/lib/page-chain";

const encodePageArgs = Schema.encodeSync(PageArgs);

interface HeldPage<Item> {
  readonly wire: unknown;
  readonly page: PageResult<Item>;
}

/** A list loaded a page at a time. */
export interface Pages<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly status: ChainStatus;
  /** Loads the next page, if there is one and none is loading. */
  readonly loadMore: () => void;
}

/** How a list reads its pages. */
interface PagesOptions {
  /** Rows per page. */
  readonly limit: number;
  /** Load every page now, for an order the server doesn't page in. */
  readonly all: boolean;
}

const usePages = <Item>(
  name: QueryName,
  schema: Schema.Decoder<PageResult<Item>>,
  { limit, all }: PagesOptions,
): Pages<Item> => {
  const [cursors, setCursors] = useState<Cursors>(FIRST_PAGE);
  const [held, setHeld] = useState<ReadonlyMap<string, HeldPage<Item>>>(new Map());
  const decode = Schema.decodeUnknownResult(schema);

  const queries = useMemo(
    () =>
      Object.fromEntries(
        cursors.map((cursor, index) => [
          keyOf(cursor),
          {
            query: readCommand,
            args: { name, args: encodePageArgs({ ...pageBounds(cursors, index), limit }) },
          },
        ]),
      ),
    [cursors, name, limit],
  );

  const results = useQueries(queries);

  let changed: Map<string, HeldPage<Item>> | null = null;

  for (const cursor of cursors) {
    const key = keyOf(cursor);
    const wire: unknown = results[key];

    if (wire instanceof Error) throw wire;

    if (wire === undefined || held.get(key)?.wire === wire) continue;

    const decoded = decode(wire);

    if (Result.isFailure(decoded)) {
      throw new InvalidResultError(
        `${name} returned an unexpected page: ${decoded.failure.message}`,
      );
    }

    changed ??= new Map(held);
    changed.set(key, { wire, page: decoded.success });
  }

  if (changed !== null) setHeld(changed);

  const current = changed ?? held;
  const pageAt = (cursor: string | null) => current.get(keyOf(cursor))?.page;
  const chain = reconcileChain(cursors, pageAt);

  if (chain !== cursors) setCursors(chain);

  const view = joinChain(chain, pageAt);
  const { status } = view;

  if (all && status.kind === "more" && !chain.includes(status.next)) {
    setCursors(extendChain(chain, status.next));
  }

  return {
    ...view,
    loadMore: () => {
      if (status.kind === "more") setCursors((list) => extendChain(list, status.next));
    },
  };
};

/** Albums, newest first. */
export const useAlbumPages = (options: PagesOptions): Pages<AlbumCard> =>
  usePages("albums.list", AlbumPage, options);

/** Artists by name. */
export const useArtistPages = (options: PagesOptions): Pages<ArtistCard> =>
  usePages("artists.list", ArtistPage, options);

/** Songs by title. */
export const useTrackPages = (options: PagesOptions): Pages<Track> =>
  usePages("tracks.list", TrackPage, options);

/**
 * Playlist order as the server changes it: `playlists.move` puts one entry right after another,
 * or at the top when it names none. Editing (C07) reorders a local draft freely; saving turns the
 * draft into the fewest such moves.
 */

/** One `playlists.move`: put `itemId` right after `afterItemId`, or first when that is null. */
export interface PlaylistMove<Id> {
  readonly itemId: Id;
  readonly afterItemId: Id | null;
}

/** `list` with the entry at `from` taken out and put back at `to`, as a drag leaves it. */
export const moveIndex = <T>(
  list: ReadonlyArray<T>,
  from: number,
  to: number,
): ReadonlyArray<T> => {
  const moving = list[from];

  if (moving === undefined || from === to) return list;
  const rest = list.toSpliced(from, 1);

  return rest.toSpliced(Math.max(0, Math.min(to, rest.length)), 0, moving);
};

/** `list` after the server applies `move`; an unknown entry leaves it unchanged. */
export const applyMove = <Id>(
  list: ReadonlyArray<Id>,
  move: PlaylistMove<Id>,
): ReadonlyArray<Id> => {
  if (!list.includes(move.itemId)) return list;
  const rest = list.filter((id) => id !== move.itemId);
  const after = move.afterItemId === null ? -1 : rest.indexOf(move.afterItemId);

  if (move.afterItemId !== null && after === -1) return list;

  return rest.toSpliced(after + 1, 0, move.itemId);
};

/** Indexes into `values` of one longest strictly increasing run, in order. */
const longestIncreasing = (values: ReadonlyArray<number>): ReadonlySet<number> => {
  // tails[k] is the index of the smallest value ending an increasing run of length k + 1.
  const tails: Array<number> = [];
  const previous: Array<number> = Array.from({ length: values.length }, () => -1);

  values.forEach((value, index) => {
    let low = 0;
    let high = tails.length;

    while (low < high) {
      const middle = (low + high) >> 1;

      if ((values[tails[middle] ?? 0] ?? 0) < value) low = middle + 1;
      else high = middle;
    }

    previous[index] = low > 0 ? (tails[low - 1] ?? -1) : -1;
    tails[low] = index;
  });

  const kept = new Set<number>();

  for (let index = tails.at(-1) ?? -1; index !== -1; index = previous[index] ?? -1) kept.add(index);

  return kept;
};

/**
 * The fewest moves that turn `current` into `target`, both the same entries. The longest run
 * already in order stays put; every other entry moves, in target order, right after the entry
 * that precedes it in `target`, which is by then in its final place.
 */
export const planMoves = <Id>(
  current: ReadonlyArray<Id>,
  target: ReadonlyArray<Id>,
): ReadonlyArray<PlaylistMove<Id>> => {
  const position = new Map(current.map((id, index) => [id, index]));
  const stays = longestIncreasing(target.map((id) => position.get(id) ?? -1));

  return target.flatMap((itemId, index) =>
    stays.has(index)
      ? []
      : [{ itemId, afterItemId: index === 0 ? null : (target[index - 1] ?? null) }],
  );
};

/**
 * The order to save from an edit draft while the server's list may have changed under it: the
 * draft's order for entries that still exist, then entries someone else added meanwhile, in the
 * server's order.
 */
export const reconcileOrder = <Id>(
  draft: ReadonlyArray<Id>,
  server: ReadonlyArray<Id>,
): ReadonlyArray<Id> => {
  const live = new Set(server);
  const drafted = new Set(draft);

  return [...draft.filter((id) => live.has(id)), ...server.filter((id) => !drafted.has(id))];
};

import { cn } from "@music/ui/lib/utils";
import { ChevronDownIcon, ChevronUpIcon, GripVerticalIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";

import {
  afterIdFor,
  dragPositions,
  dropIndex,
  moveItem,
  orderToMoveFrom,
  sameOrder,
} from "@/lib/reorder";
import type { DragState, DropSide } from "@/lib/reorder";

/**
 * How long without a dragover before a pointer event counts as the drag being over. Browsers send
 * dragover about every 50 ms during a drag.
 */
const DRAG_IDLE_MS = 500;

/** No drag in progress. */
const NO_DRAG = { id: null, over: null } as const;

/** Props that make a row a drag source and drop target. */
interface DragRowProps {
  readonly draggable: true;
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}

/** Reordering for one list: drag and drop, arrow keys on a handle, and up/down buttons. */
export interface Reorder {
  /** Drag and drop on desktop. Stable for the list's life; it reads the drag when called. */
  readonly rowProps: (index: number) => DragRowProps;
  /** Where a dragged entry would land relative to this row, for the drop line. */
  readonly dropSide: (index: number) => DropSide | null;
  /**
   * Moves the entry at `index` by `delta` places (the keyboard and phone alternative). Stable for
   * the list's life.
   */
  readonly moveBy: (index: number, delta: number) => void;
  /** The index of the row being dragged, or null. A windowed list keeps its block rendered. */
  readonly dragging: number | null;
}

/**
 * Reorders the entries `ids`, calling `onMove` with the entry and the one it should now follow
 * (`anchor` at the top). The list itself comes back from the server's live query. A drag follows
 * its entries, not their indexes, so it survives the list changing under it; it ends only if the
 * dragged entry leaves. `rowProps` and `moveBy` stay the same functions, so rows memoized on them
 * only re-render for their drop line.
 */
export const useReorder = <Id extends string>(
  ids: ReadonlyArray<Id>,
  anchor: Id | null,
  onMove: (id: Id, afterId: Id | null) => Promise<void>,
): Reorder => {
  const [drag, setDrag] = useState<DragState<Id>>(NO_DRAG);
  const positions = dragPositions(ids, drag);

  // The dragged entry left the list (removed elsewhere): the drag ends, so its block unpins and a
  // later drop can't move anything. Set while rendering, as React documents for derived state.
  if (drag.id !== null && positions === null) setDrag(NO_DRAG);

  // Orders the list should pass through while moves are in flight; see `orderToMoveFrom`.
  const expected = useRef<ReadonlyArray<ReadonlyArray<Id>>>([]);

  // What the stable handlers read when they run: the list, the drag, and the move callback as of
  // the latest commit.
  const latest = useRef({ ids, anchor, onMove, drag });

  useLayoutEffect(() => {
    latest.current = { ids, anchor, onMove, drag };
  });

  // A drag whose source row remounted (it moved to another block of a windowed list) never gets
  // its dragend. While a drag is live the browser sends dragover every few dozen milliseconds, even
  // with the pointer still; a pointer event long after the last one means the drag is over.
  const dragging = drag.id !== null;
  const lastDragOver = useRef(0);

  useEffect(() => {
    if (!dragging) return undefined;

    lastDragOver.current = performance.now();

    const onDragOver = () => {
      lastDragOver.current = performance.now();
    };

    const onPointer = () => {
      if (performance.now() - lastDragOver.current > DRAG_IDLE_MS) setDrag(NO_DRAG);
    };

    window.addEventListener("dragover", onDragOver, { capture: true, passive: true });
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });

    return () => {
      window.removeEventListener("dragover", onDragOver, { capture: true });
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [dragging]);

  const handlers = useMemo(() => {
    /** Moves `id` to `to` in the order the list is heading to. */
    const move = (id: Id, to: (from: number, base: ReadonlyArray<Id>) => number) => {
      const { ids: current, anchor: top, onMove: report } = latest.current;

      // The server reached the last order expected: nothing is in flight any more.
      if (sameOrder(expected.current.at(-1) ?? [], current)) expected.current = [];

      const base = orderToMoveFrom(current, expected.current);
      const from = base.indexOf(id);
      const target = to(from, base);

      if (from === -1 || target === from || target < 0 || target >= base.length) return;
      expected.current = [
        ...(base === current ? [current] : expected.current),
        moveItem(base, from, target),
      ];
      // A failed move never reaches the server, so the orders after it never will either.
      report(id, afterIdFor(base, from, target, top)).catch(() => {
        expected.current = [];
      });
    };

    const reset = () => setDrag(NO_DRAG);

    const rowProps = (index: number): DragRowProps => ({
      draggable: true,
      onDragStart: (event) => {
        const id = latest.current.ids[index];

        if (id === undefined) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
        setDrag({ id, over: null });
      },
      onDragOver: (event) => {
        const id = latest.current.ids[index];

        if (latest.current.drag.id === null || id === undefined) return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        const side = event.clientY < box.top + box.height / 2 ? "before" : "after";

        // From the latest state, not the last commit: several dragovers can arrive before React
        // renders, and an unchanged drop line must not schedule another render.
        setDrag((current) =>
          current.id === null || (current.over?.id === id && current.over.side === side)
            ? current
            : { ...current, over: { id, side } },
        );
      },
      onDrop: (event) => {
        event.preventDefault();
        const { id, over } = latest.current.drag;

        // Next to the entry the person saw the drop line on, in the order the list is heading to
        // (an earlier move may still be on its way to the server).
        if (id !== null && over !== null) {
          move(id, (from, base) => {
            const target = base.indexOf(over.id);

            return target === -1 ? from : dropIndex(from, target, over.side);
          });
        }

        reset();
      },
      onDragEnd: reset,
    });

    const moveBy = (index: number, delta: number) => {
      const id = latest.current.ids[index];

      if (id !== undefined) move(id, (from) => from + delta);
    };

    return { rowProps, moveBy };
  }, []);

  return {
    ...handlers,
    dropSide: (index) => {
      const over = positions?.over ?? null;

      return over !== null && over.index === index && positions?.from !== index ? over.side : null;
    },
    dragging: positions?.from ?? null,
  };
};

/** How far each arrow key moves an entry. */
const KEY_STEPS = new Map([
  ["ArrowUp", -1],
  ["ArrowDown", 1],
]);

/**
 * The drag handle. Focus it and press the arrow keys to move the entry without a mouse; screen
 * readers hear how.
 */
export function ReorderHandle({
  label,
  index,
  count,
  reorder,
  className,
}: {
  readonly label: string;
  readonly index: number;
  readonly count: number;
  readonly reorder: Pick<Reorder, "moveBy">;
  readonly className?: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const delta = KEY_STEPS.get(event.key);

    if (delta === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    reorder.moveBy(index, delta);
  };

  return (
    <button
      type="button"
      aria-label={`Move ${label}`}
      aria-description={`Position ${index + 1} of ${count}. Press the up or down arrow to move it.`}
      onKeyDown={onKeyDown}
      className={cn(
        "relative flex size-7 shrink-0 cursor-grab items-center justify-center rounded-sm text-text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing",
        className,
      )}
    >
      <GripVerticalIcon aria-hidden className="size-4" />
    </button>
  );
}

/** Up and down buttons for reorder mode on phones, where dragging fights scrolling. */
export function MoveButtons({
  label,
  index,
  count,
  reorder,
}: {
  readonly label: string;
  readonly index: number;
  readonly count: number;
  readonly reorder: Pick<Reorder, "moveBy">;
}) {
  const button =
    "relative flex size-11 shrink-0 items-center justify-center rounded-full text-text outline-none hover:bg-text/8 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-(--opacity-disabled)";

  return (
    <span className="flex shrink-0 items-center">
      <button
        type="button"
        aria-label={`Move ${label} up`}
        disabled={index === 0}
        onClick={() => reorder.moveBy(index, -1)}
        className={button}
      >
        <ChevronUpIcon aria-hidden className="size-5" />
      </button>
      <button
        type="button"
        aria-label={`Move ${label} down`}
        disabled={index === count - 1}
        onClick={() => reorder.moveBy(index, 1)}
        className={button}
      >
        <ChevronDownIcon aria-hidden className="size-5" />
      </button>
    </span>
  );
}

import { cn } from "@music/ui/lib/utils";
import { ChevronDownIcon, ChevronUpIcon, GripVerticalIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";

import { afterIdFor, dropIndex, moveItem, orderToMoveFrom, sameOrder } from "@/lib/reorder";
import type { DropSide } from "@/lib/reorder";

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
  /** Drag and drop on desktop. */
  readonly rowProps: (index: number) => DragRowProps;
  /** Where a dragged entry would land relative to this row, for the drop line. */
  readonly dropSide: (index: number) => DropSide | null;
  /** Moves the entry at `index` by `delta` places (the keyboard and phone alternative). */
  readonly moveBy: (index: number, delta: number) => void;
}

/**
 * Reorders the entries `ids`, calling `onMove` with the entry and the one it should now follow
 * (`anchor` at the top). The list itself comes back from the server's live query.
 */
export const useReorder = <Id extends string>(
  ids: ReadonlyArray<Id>,
  anchor: Id | null,
  onMove: (id: Id, afterId: Id | null) => Promise<void>,
): Reorder => {
  const [dragging, setDragging] = useState<number | null>(null);

  const [over, setOver] = useState<{ readonly index: number; readonly side: DropSide } | null>(
    null,
  );

  // Orders the list should pass through while moves are in flight; see `orderToMoveFrom`.
  const expected = useRef<ReadonlyArray<ReadonlyArray<Id>>>([]);

  /** Moves `id` to `to` in the order the list is heading to. */
  const move = (id: Id, to: (from: number) => number) => {
    // The server reached the last order expected: nothing is in flight any more.
    if (sameOrder(expected.current.at(-1) ?? [], ids)) expected.current = [];

    const base = orderToMoveFrom(ids, expected.current);
    const from = base.indexOf(id);
    const target = to(from);

    if (from === -1 || target === from || target < 0 || target >= base.length) return;
    expected.current = [...(base === ids ? [ids] : expected.current), moveItem(base, from, target)];
    // A failed move never reaches the server, so the orders after it never will either.
    onMove(id, afterIdFor(base, from, target, anchor)).catch(() => {
      expected.current = [];
    });
  };

  const moveAt = (index: number, to: (from: number) => number) => {
    const id = ids[index];

    if (id !== undefined) move(id, to);
  };

  const reset = () => {
    setDragging(null);
    setOver(null);
  };

  return {
    rowProps: (index) => ({
      draggable: true,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", ids[index] ?? "");
        setDragging(index);
      },
      onDragOver: (event) => {
        if (dragging === null) return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        const side = event.clientY < box.top + box.height / 2 ? "before" : "after";

        if (over?.index !== index || over.side !== side) setOver({ index, side });
      },
      onDrop: (event) => {
        event.preventDefault();

        if (dragging !== null && over !== null) {
          const target = dropIndex(dragging, over.index, over.side);

          moveAt(dragging, () => target);
        }

        reset();
      },
      onDragEnd: reset,
    }),
    dropSide: (index) =>
      over !== null && over.index === index && dragging !== null && dragging !== index
        ? over.side
        : null,
    moveBy: (index, delta) => {
      moveAt(index, (from) => from + delta);
    },
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
  readonly reorder: Reorder;
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
  readonly reorder: Reorder;
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

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { anchorTop, followLines, LINES_WAITING } from "./lyrics-follow";
import type { FollowScroll, LineFollow, LineFollowEvent, LinesLayout } from "./lyrics-follow";

/** Where following stands after some events, with every scroll it asked the lines to make. */
interface Run {
  readonly state: LineFollow;
  readonly scrolls: ReadonlyArray<FollowScroll>;
}

/** Runs `events` from `state`. */
const run = (state: LineFollow, events: ReadonlyArray<LineFollowEvent>): Run =>
  events.reduce<Run>(
    (at, event) => {
      const step = followLines(at.state, event);

      return {
        state: step.state,
        scrolls: step.scroll === undefined ? at.scrolls : [...at.scrolls, step.scroll],
      };
    },
    { state, scrolls: [] },
  );

const placedAt = (top: number): LineFollow =>
  run(LINES_WAITING, [
    { type: "laidOut", top },
    { type: "scrolled", offset: top },
  ]).state;

describe("followLines", () => {
  it("places the sung line at once when it is first measured, then follows it with an animation", () => {
    const first = run(LINES_WAITING, [
      { type: "started", top: null },
      { type: "laidOut", top: 300 },
    ]);

    expect(first.scrolls).toEqual([{ top: 300, animated: false }]);

    const next = run(first.state, [
      { type: "scrolled", offset: 300 },
      { type: "started", top: 420 },
      { type: "scrolled", offset: 380 },
      { type: "scrolled", offset: 420 },
    ]);

    expect(next.scrolls).toEqual([{ top: 420, animated: true }]);
    expect(next.state).toEqual({ kind: "placed", offset: 420, top: 420 });
  });

  it("stops following as soon as something else moves the lines, even while paused", () => {
    // A tap on the status bar or VoiceOver's three-finger scroll: no drag, no new line.
    const moved = run(placedAt(300), [{ type: "scrolled", offset: 0 }]);

    expect(moved.state.kind).toBe("released");

    const later = run(moved.state, [
      { type: "started", top: 420 },
      { type: "laidOut", top: 430 },
    ]);

    expect(later.scrolls).toEqual([]);
    expect(later.state.kind).toBe("released");
  });

  it("stops following when the person drags, and leaves the lines where they put them", () => {
    const dragged = run(placedAt(300), [
      { type: "dragged" },
      { type: "scrolled", offset: 900 },
      { type: "started", top: 420 },
      { type: "scrollSettled" },
    ]);

    expect(dragged.scrolls).toEqual([]);
    expect(dragged.state).toEqual({ kind: "released", offset: 900 });
  });

  it("settles a follow scroll on its end even when no scroll event reached its target", () => {
    const landed = run(placedAt(300), [
      { type: "started", top: 420 },
      { type: "scrolled", offset: 380 },
      { type: "scrollSettled" },
    ]);

    // The scroll ended short of 420: something else stopped it, so the lines are the person's.
    expect(landed.state.kind).toBe("released");

    const reached = run(placedAt(300), [
      { type: "started", top: 420 },
      { type: "scrolled", offset: 420 },
      { type: "scrollSettled" },
      { type: "scrolled", offset: 0 },
    ]);

    // Settled, a later scroll nobody asked for is seen as one.
    expect(reached.state.kind).toBe("released");
  });

  it("does not take a follow scroll still under way for the person's", () => {
    const moving = run(placedAt(300), [
      { type: "started", top: 420 },
      { type: "scrolled", offset: 310 },
      { type: "scrolled", offset: 390 },
    ]);

    expect(moving.state).toEqual({ kind: "moving", offset: 390, top: 420 });
  });

  it("stops an animation under way when the new place is where the lines already are", () => {
    const moving = run(placedAt(300), [
      { type: "started", top: 420 },
      { type: "scrolled", offset: 360 },
      { type: "laidOut", top: 361 },
    ]);

    expect(moving.scrolls.at(-1)).toEqual({ top: 361, animated: false });
  });

  it("follows again from wherever the lines are when asked", () => {
    const back = run(placedAt(300), [
      { type: "dragged" },
      { type: "scrolled", offset: 900 },
      { type: "follow", top: 420 },
    ]);

    expect(back.scrolls).toEqual([{ top: 420, animated: true }]);
    expect(back.state.kind).toBe("moving");
  });

  it("repositions on an explicit follow even when the line and following have not changed", () => {
    // The line moved (Dynamic Type) before the next frame's layout pass put it back.
    const again = run(placedAt(300), [{ type: "follow", top: 340 }]);

    expect(again.scrolls).toEqual([{ top: 340, animated: true }]);
  });

  it("waits for a measurement when asked to follow before the lines are laid out", () => {
    const back = run(placedAt(300), [{ type: "dragged" }, { type: "follow", top: null }]);

    expect(back.state.kind).toBe("waiting");
    expect(run(back.state, [{ type: "laidOut", top: 500 }]).scrolls).toEqual([
      { top: 500, animated: false },
    ]);
  });

  it("never scrolls or follows again after a drag until asked to", () => {
    const quiet = fc.oneof(
      fc.record({ type: fc.constant("started"), top: fc.option(fc.nat(5000)) }),
      fc.record({ type: fc.constant("laidOut"), top: fc.option(fc.nat(5000)) }),
      fc.record({ type: fc.constant("scrolled"), offset: fc.nat(5000) }),
      fc.constant({ type: "scrollSettled" } as const),
      fc.constant({ type: "dragged" } as const),
    );

    fc.assert(
      fc.property(fc.nat(5000), fc.array(quiet), (top, events) => {
        const after = run(placedAt(top), [{ type: "dragged" }, ...events]);

        expect(after.scrolls).toEqual([]);
        expect(after.state.kind).toBe("released");
      }),
    );
  });
});

/** B12's measures: a 24pt lead before the first line, a 24pt gap between lines, 32pt rows. */
const B12 = { lead: 24, gap: 24, row: 32 } as const;

/** Lines of `rows` rows each, laid out from the lead, with a viewport-tall room under the last. */
const linesOf = (rows: ReadonlyArray<number>, viewport = 320): LinesLayout => {
  let y = B12.lead;

  const lines = rows.map((count) => {
    const box = { y, height: count * B12.row };
    y += box.height + B12.gap;

    return box;
  });

  return { viewport, content: y + viewport, lines };
};

/** The rows each line shows in from the top of the lyrics, or null for one out of view. */
const shownFrom = (layout: LinesLayout, top: number) =>
  layout.lines.map((box) => (box === undefined || box.y < top ? null : box.y - top));

describe("anchorTop", () => {
  it("shows a one-row line whole at the lead above the sung line, as B12 does", () => {
    const layout = linesOf([1, 1, 2, 1]);
    const top = anchorTop(layout, 2);

    expect(top).not.toBeNull();
    expect(shownFrom(layout, top ?? 0).slice(0, 3)).toStrictEqual([
      null,
      B12.lead,
      B12.lead + B12.row + B12.gap,
    ]);
  });

  it("shows a two-row line whole above the sung line rather than lose it", () => {
    const layout = linesOf([1, 2, 1]);
    const top = anchorTop(layout, 2);

    expect(shownFrom(layout, top ?? 0)).toStrictEqual([
      null,
      B12.lead,
      B12.lead + 2 * B12.row + B12.gap,
    ]);
  });

  it("scrolls a long line before the sung one out whole and puts the sung line at the lead", () => {
    const layout = linesOf([1, 3, 1]);
    const top = anchorTop(layout, 2) ?? 0;
    const before = layout.lines[1];

    expect(before === undefined ? null : before.y + before.height).toBeLessThanOrEqual(top);
    expect(shownFrom(layout, top)[2]).toBe(B12.lead);
  });

  it("never cuts a line at the top edge, whatever the lines' lengths and the lyrics' height", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 200, max: 600 }),
        fc.nat(),
        (rows, viewport, pick) => {
          const layout = linesOf(rows, viewport);
          const top = anchorTop(layout, pick % rows.length) ?? 0;

          return layout.lines.every(
            (box) => box === undefined || box.y >= top || box.y + box.height <= top,
          );
        },
      ),
    );
  });

  it("sits at the top before the first line starts and while it is sung", () => {
    const layout = linesOf([2, 1]);

    expect(anchorTop(layout, -1)).toBe(0);
    expect(anchorTop(layout, 0)).toBe(0);
  });

  it("keeps the scroll inside the content", () => {
    const layout = linesOf([1, 1, 1]);

    expect(anchorTop({ ...layout, content: 350 }, 2)).toBe(350 - layout.viewport);
  });

  it("is unknown until the lyrics and the lines it needs are measured", () => {
    const layout = linesOf([1, 1, 1]);
    const [first, , third] = layout.lines;

    expect(anchorTop({ ...layout, viewport: 0 }, 1)).toBeNull();
    expect(anchorTop({ ...layout, lines: [first, undefined, third] }, 2)).toBeNull();
    expect(anchorTop({ ...layout, lines: [undefined, undefined, third] }, 0)).toBeNull();
    expect(anchorTop(layout, 3)).toBeNull();
  });
});

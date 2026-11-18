import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ActionStatus } from "./people/action";
import type { ApprovalPhase } from "./people/approval";
import { button, sharedPicker, tile } from "./people/fixtures";
import { SharedPickerView, kidHolder } from "./shared-picker";
import type { Leave } from "./shared-picker";

const noop = (): void => undefined;

const LOCKED = { state: "locked", because: ["kid-listed"], opensWith: "self" } as const;

const dad = tile("dad", { lock: LOCKED });

const mia = tile("mia", { kid: true });

const picker = sharedPicker([dad, mia]);

const render = (
  fields: { readonly opening?: ActionStatus; readonly leave?: Leave | null } = {},
  shown = picker,
): string =>
  renderToStaticMarkup(
    <SharedPickerView
      picker={shown}
      opening={fields.opening ?? { kind: "idle" }}
      leave={fields.leave ?? null}
      onPick={noop}
      onAskLeave={noop}
    />,
  );

const leaving = (phase: ApprovalPhase): Leave => ({ kid: mia, phase });

describe("SharedPickerView", () => {
  it("lists everyone, locks the locked tiles, and marks kids", () => {
    const html = render();

    expect(html).toContain('aria-label="dad, locked"');
    expect(html).toContain('aria-label="mia, kid"');
    expect(html).toContain(">Kid</span>");
    expect(html).not.toContain("Ask an adult");
  });

  it("says so when no one is listed", () => {
    expect(render({}, sharedPicker([]))).toContain(
      "No one has put themselves on shared devices yet.",
    );
  });

  it("holds the tiles while one opens, and shows why opening failed", () => {
    expect(render({ opening: { kind: "pending" } })).toContain('disabled=""');
    expect(render({ opening: { kind: "failed", message: "Too many tries." } })).toContain(
      "Too many tries.",
    );
  });

  it("offers a kid who holds the device an adult's leave", () => {
    const html = render({ leave: leaving({ kind: "idle" }) });

    expect(html).toContain("mia is using this device. An adult can let them leave.");
    expect(button(html, "Ask an adult").disabled).toBe(false);
    expect(button(render({ leave: leaving({ kind: "asking" }) }), "Ask an adult").disabled).toBe(
      true,
    );
  });

  it("waits for the adult, and offers to ask again after a refusal", () => {
    expect(render({ leave: leaving({ kind: "waiting" }) })).toContain(
      "Waiting for an adult to answer on another device.",
    );

    const denied = render({ leave: leaving({ kind: "denied" }) });

    expect(denied).toContain("An adult said no.");
    expect(button(denied, "Ask again").disabled).toBe(false);
  });
});

describe("kidHolder", () => {
  it("is the kid whose tile holds the device, and no one for an adult holder", () => {
    expect(kidHolder(sharedPicker([dad, mia], { holder: mia.userId }))).toBe(mia);
    expect(kidHolder(sharedPicker([dad, mia], { holder: dad.userId }))).toBeNull();
    expect(kidHolder(sharedPicker([dad, mia]))).toBeNull();
  });
});

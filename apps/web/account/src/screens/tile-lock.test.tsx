import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SharedTile } from "@/session/platform-types";

import type { ApprovalPhase } from "./people/approval";
import { anApprovalId, button, sharedPicker, tile } from "./people/fixtures";
import { TileLockView, methodFor, proversOf } from "./tile-lock";
import type { Typed } from "./tile-lock";

type Locked = Extract<SharedTile["lock"], { readonly state: "locked" }>;

const noop = (): void => undefined;

const lockOpenedBy = (opensWith: Locked["opensWith"]): Locked => ({
  state: "locked",
  because: ["admin-rule"],
  opensWith,
});

const SELF = lockOpenedBy("self");

const ADULT = lockOpenedBy("adult");

const EITHER = lockOpenedBy("self-or-adult");

const ada = tile("ada", { lock: SELF, code: "ready" });

const mia = tile("mia", { kid: true, lock: ADULT });

const dad = tile("dad", { code: "off" });

const mom = tile("mom");

const leo = tile("leo", { kid: true });

const render = ({
  shown = ada,
  lock = SELF,
  typed,
  ask = { kind: "idle" },
}: {
  readonly shown?: SharedTile;
  readonly lock?: Locked;
  readonly typed?: Typed | null;
  readonly ask?: ApprovalPhase | null;
}): string =>
  renderToStaticMarkup(
    <TileLockView
      tile={shown}
      lock={lock}
      typed={
        typed === undefined
          ? { provers: [shown], prover: shown, method: "code", unlocking: { kind: "idle" } }
          : typed
      }
      ask={ask}
      onProver={noop}
      onMethod={noop}
      onUnlock={noop}
      onAsk={noop}
      onBack={noop}
    />,
  );

const typedPassword = (unlocking: Typed["unlocking"]): Typed => ({
  provers: [ada],
  prover: ada,
  method: "password",
  unlocking,
});

describe("proversOf", () => {
  const picker = sharedPicker([ada, mia, dad, mom, leo]);

  it("takes only the person's own proof for a self lock", () => {
    expect(proversOf(picker, ada, SELF)).toEqual([ada]);
  });

  it("takes any listed adult's, never a kid's, for an adult lock", () => {
    expect(proversOf(picker, mia, ADULT)).toEqual([ada, dad, mom]);
  });

  it("puts the person first, then the adults, when either opens it", () => {
    expect(proversOf(picker, mia, EITHER)).toEqual([mia, ada, dad, mom]);
  });
});

describe("methodFor", () => {
  it("starts on the code when it is ready, and keeps the choice", () => {
    expect(methodFor(ada, null)).toBe("code");
    expect(methodFor(ada, "password")).toBe("password");
  });

  it("uses the password when the code is unset or off here", () => {
    expect(methodFor(mom, "code")).toBe("password");
    expect(methodFor(dad, "code")).toBe("password");
  });
});

describe("TileLockView", () => {
  it("asks for the person's code, with the password and another device as other ways", () => {
    const html = render({});

    expect(html).toContain("Unlock ada");
    expect(html).toContain("Only ada can open this tile.");
    expect(html).toContain("ada&#x27;s unlock code");
    expect(html).toContain('inputMode="numeric"');
    expect(button(html, "Use the password").disabled).toBe(false);
    expect(button(html, "Unlock").disabled).toBe(true);
    expect(button(html, "Ask on another device").disabled).toBe(false);
    expect(button(html, "Choose someone else").disabled).toBe(false);
  });

  it("asks for the password and says why when the code is off here", () => {
    const off = tile("ada", { lock: SELF, code: "off" });

    const html = render({
      shown: off,
      typed: { provers: [off], prover: off, method: "password", unlocking: { kind: "idle" } },
    });

    expect(html).toContain("ada&#x27;s password");
    expect(html).toContain(
      "ada&#x27;s unlock code is off on this device after 5 wrong tries. Typing the password turns it back on.",
    );
    expect(html).not.toContain("Use the unlock code");
  });

  it("shows a wrong password and holds the form while it checks", () => {
    expect(
      render({ typed: typedPassword({ kind: "failed", message: "Wrong password." }) }),
    ).toContain("Wrong password.");
    expect(button(render({ typed: typedPassword({ kind: "pending" }) }), "Unlock").disabled).toBe(
      true,
    );
  });

  it("lets an adult unlock a kid's tile, choosing which adult, with no ask", () => {
    const html = render({
      shown: mia,
      lock: ADULT,
      typed: { provers: [dad, mom], prover: mom, method: "password", unlocking: { kind: "idle" } },
      ask: null,
    });

    expect(html).toContain("An adult opens this tile for mia.");
    expect(html).toContain("Who&#x27;s unlocking");
    expect(html).toContain("mom&#x27;s password");
    expect(html).not.toContain("Ask on another device");
  });

  it("says no one can unlock it when no adult is listed", () => {
    expect(render({ shown: mia, lock: ADULT, typed: null, ask: null })).toContain(
      "No adult is on shared devices to unlock it.",
    );
  });

  it("follows an ask to another device through waiting, refusal, expiry, and approval", () => {
    expect(render({ ask: { kind: "waiting" } })).toContain(
      "Approve on a device where ada is signed in.",
    );
    expect(render({ ask: { kind: "denied" } })).toContain("The request was turned down.");
    expect(render({ ask: { kind: "expired" } })).toContain("No one answered in time.");

    const approved = render({ ask: { kind: "approved", approvalId: anApprovalId("a1") } });

    expect(approved).toContain("Approved. Opening…");
    expect(button(approved, "Unlock").disabled).toBe(true);
  });
});

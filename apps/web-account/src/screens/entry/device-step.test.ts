import { describe, expect, it } from "vitest";

import type { Answer } from "./device";
import { deviceStep } from "./device-step";
import type { CodeLookup, DeviceInputs } from "./device-step";

const me = { username: "kim", scopes: ["account", "movies:read"] };

const found = (state: CodeLookup["state"]): DeviceInputs["lookup"] => ({
  status: "success",
  data: { clientName: "media CLI", state },
});

const inputs = (overrides: Partial<DeviceInputs>): DeviceInputs => ({
  letters: "HDKRBGTL",
  submitted: "HDKR-BGTL",
  lookup: found("pending"),
  decision: null,
  answer: { kind: "idle" },
  me,
  ...overrides,
});

describe("deviceStep", () => {
  it("asks for a code before one is submitted", () => {
    expect(
      deviceStep(inputs({ letters: "HDK", submitted: null, lookup: { status: "loading" } })),
    ).toEqual({
      kind: "enter",
      letters: "HDK",
      problem: null,
    });
  });

  it("checks a submitted code", () => {
    expect(deviceStep(inputs({ lookup: { status: "loading" } }))).toEqual({ kind: "checking" });
  });

  it("asks to approve a waiting device with this session's scopes", () => {
    expect(deviceStep(inputs({}))).toEqual({
      kind: "decide",
      device: {
        clientName: "media CLI",
        userCode: "HDKR-BGTL",
        username: "kim",
        scopes: me.scopes,
      },
      answer: { kind: "idle" },
    });
  });

  it("refuses a code no device waits on until the person edits it", () => {
    const lookup = {
      status: "error",
      error: { _tag: "NotFound" },
      retry: () => undefined,
    } as const;

    expect(deviceStep(inputs({ lookup }))).toMatchObject({
      kind: "enter",
      problem: { tone: "danger" },
    });
    expect(deviceStep(inputs({ lookup, letters: "HDKRBGT" }))).toEqual({
      kind: "enter",
      letters: "HDKRBGT",
      problem: null,
    });
  });

  it.each([
    ["expired", "That code has expired."],
    ["denied", "That code was denied."],
    ["approved", "That code was already used."],
    ["redeemed", "That code was already used."],
  ] as const)("warns that a %s code can't be approved", (state, title) => {
    expect(deviceStep(inputs({ lookup: found(state) }))).toMatchObject({
      kind: "enter",
      problem: { tone: "warning", title },
    });
  });

  it("keeps the device on screen while its approval is in flight", () => {
    const answer: Answer = { kind: "approving" };

    expect(deviceStep(inputs({ lookup: found("approved"), answer }))).toMatchObject({
      kind: "decide",
      answer,
    });
  });

  it("shows the answer once the core took it, whatever the code's state", () => {
    expect(
      deviceStep(
        inputs({
          lookup: found("redeemed"),
          decision: { kind: "approved", clientName: "media CLI" },
        }),
      ),
    ).toEqual({ kind: "approved", clientName: "media CLI", username: "kim" });
    expect(
      deviceStep(
        inputs({ lookup: found("denied"), decision: { kind: "denied", clientName: "media CLI" } }),
      ),
    ).toEqual({ kind: "denied", clientName: "media CLI" });
  });

  it("offers a retry when the lookup fails otherwise", () => {
    const lookup = {
      status: "error",
      error: { _tag: "TransportError", message: "down" },
      retry: () => undefined,
    } as const;

    expect(deviceStep(inputs({ lookup }))).toMatchObject({ kind: "unreachable" });
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DeviceApprovalView } from "./device";
import type { DeviceActions, DeviceStep } from "./device";
import { isDisabled } from "./render";

const noop = () => undefined;

const actions: DeviceActions = {
  onLettersChange: noop,
  onSubmitCode: noop,
  onApprove: noop,
  onDeny: noop,
  onRetry: noop,
  onStartOver: noop,
};

const page = (step: DeviceStep): string =>
  renderToStaticMarkup(<DeviceApprovalView step={step} actions={actions} />);

const device = {
  clientName: "media CLI",
  userCode: "HDKR-BGTL",
  username: "kim",
  scopes: ["account", "movies:read"],
};

describe("DeviceApprovalView", () => {
  it("asks for the eight-letter code, and continues once it is complete", () => {
    const partial = page({ kind: "enter", letters: "HDK", problem: null });

    expect(partial).toContain("Enter the code your device shows.");
    expect(partial).toContain('aria-label="Character 8 of 8"');
    expect(partial).not.toContain("Character 9");
    expect(isDisabled(partial, "Continue")).toBe(true);
    expect(
      isDisabled(page({ kind: "enter", letters: "HDKRBGTL", problem: null }), "Continue"),
    ).toBe(false);
  });

  it("explains a code that can't be approved", () => {
    const html = page({
      kind: "enter",
      letters: "HDKRBGTL",
      problem: { title: "That code has expired.", tone: "warning", message: "HDKR-BGTL expired." },
    });

    expect(html).toContain("That code has expired.");
    expect(html).toContain("HDKR-BGTL expired.");
    expect(isDisabled(html, "Continue")).toBe(true);
  });

  it("shows a spinner while checking", () => {
    expect(page({ kind: "checking" })).toContain('aria-label="Checking the code"');
  });

  it("shows the device, the person, and what it can do, with Approve and Deny", () => {
    const html = page({ kind: "decide", device, answer: { kind: "idle" } });

    expect(html).toContain("media CLI wants to sign in as kim.");
    expect(html).toContain("HDKR-BGTL");
    expect(html).toContain("account · movies:read");
    expect(isDisabled(html, "Approve")).toBe(false);
    expect(isDisabled(html, "Deny")).toBe(false);
  });

  it("disables both answers while one is in flight", () => {
    const html = page({ kind: "decide", device, answer: { kind: "approving" } });

    expect(isDisabled(html, "Approve")).toBe(true);
    expect(isDisabled(html, "Deny")).toBe(true);
  });

  it("shows why an answer failed", () => {
    expect(
      page({
        kind: "decide",
        device,
        answer: { kind: "failed", message: "That code has expired." },
      }),
    ).toContain("That code has expired.");
  });

  it("confirms an approval", () => {
    const html = page({ kind: "approved", clientName: "media CLI", username: "kim" });

    expect(html).toContain("media CLI is signed in.");
    expect(html).toContain("It signed in as kim.");
  });

  it("confirms a denial", () => {
    expect(page({ kind: "denied", clientName: "media CLI" })).toContain("media CLI was denied.");
  });

  it("offers a retry when the code could not be checked", () => {
    const html = page({ kind: "unreachable", message: "Can't reach the server." });

    expect(html).toContain("Can&#x27;t check that code.");
    expect(isDisabled(html, "Try again")).toBe(false);
  });
});

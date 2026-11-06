import { describe, expect, it } from "vitest";

import { isDisabled, renderPage } from "./entry/render";
import type { Submission } from "./entry/submission";
import { SetUpOwnerView } from "./set-up-owner";

const noop = () => undefined;

const page = (password: string, submission: Submission = { kind: "idle" }): string =>
  renderPage(
    <SetUpOwnerView
      username="owner"
      password={password}
      submission={submission}
      onUsernameChange={noop}
      onPasswordChange={noop}
      onSubmit={noop}
    />,
  );

describe("SetUpOwnerView", () => {
  it("asks for the owner's username and a new password with its rule", () => {
    const html = page("");

    expect(html).toContain("Set up your server.");
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain("8 to 256 characters");
    expect(isDisabled(html, "Create owner account")).toBe(false);
  });

  it("counts the password once it fits the rule", () => {
    expect(page("short")).not.toContain("5 characters");
    expect(page("long enough")).toContain("11 characters");
  });

  it("disables submit while creating the owner", () => {
    expect(isDisabled(page("long enough", { kind: "submitting" }), "Create owner account")).toBe(
      true,
    );
  });

  it("shows why it could not create the owner", () => {
    const html = page("long enough", {
      kind: "failed",
      message: "This server has an owner now. Sign in instead.",
    });

    expect(html).toContain("This server has an owner now. Sign in instead.");
  });
});

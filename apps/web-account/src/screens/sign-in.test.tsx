import { describe, expect, it } from "vitest";

import { isDisabled, renderPage } from "./entry/render";
import type { Submission } from "./entry/submission";
import { SignInView } from "./sign-in";

const noop = () => undefined;

const page = (submission: Submission, adding = false): string =>
  renderPage(
    <SignInView
      adding={adding}
      username="ana"
      password="hunter22"
      submission={submission}
      onUsernameChange={noop}
      onPasswordChange={noop}
      onSubmit={noop}
    />,
  );

describe("SignInView", () => {
  it("asks for a username and password", () => {
    const html = page({ kind: "idle" });

    expect(html).toContain("Sign in.");
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).not.toContain("Cancel");
    expect(isDisabled(html, "Sign in")).toBe(false);
  });

  it("adds someone with a way back to the picker", () => {
    const html = page({ kind: "idle" }, true);

    expect(html).toContain("Add someone.");
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Cancel<\/a>/u);
  });

  it("disables submit while signing in", () => {
    expect(isDisabled(page({ kind: "submitting" }), "Sign in")).toBe(true);
  });

  it("shows a failure under the fields", () => {
    expect(page({ kind: "failed", message: "Wrong username or password." })).toContain(
      "Wrong username or password.",
    );
  });

  it("sends a shared device to its picker", () => {
    const html = page({ kind: "sharedDevice" });

    expect(html).toContain("This browser is a shared device.");
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Go to the picker<\/a>/u);
  });
});

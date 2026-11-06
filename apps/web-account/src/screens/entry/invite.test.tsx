import { describe, expect, it } from "vitest";

import { isDisabled, renderPage } from "./render";
import { InviteView } from "./invite";
import type { Invite } from "./invite";
import { MissingLink } from "./link-page";
import type { LinkForm, LinkState } from "./link-page";

const form: LinkForm = {
  username: "",
  password: "",
  submission: { kind: "idle" },
  onUsernameChange: () => undefined,
  onPasswordChange: () => undefined,
  onSubmit: () => undefined,
};

const page = (state: LinkState<Invite>, submitting = false): string =>
  renderPage(
    <InviteView
      state={state}
      form={submitting ? { ...form, submission: { kind: "submitting" } } : form}
    />,
  );

const OPEN: LinkState<Invite> = {
  kind: "open",
  link: { invitedBy: "ana", role: "admin", expiresAt: Date.UTC(2026, 10, 20, 12) },
};

describe("InviteView", () => {
  it("shows who invited and the role, then asks for a new account", () => {
    const html = page(OPEN);

    expect(html).toContain("ana invited you");
    expect(html).toContain("joins as admin");
    expect(html).toContain('autoComplete="new-password"');
    expect(isDisabled(html, "Create account")).toBe(false);
  });

  it("disables joining while it signs the new person in", () => {
    expect(isDisabled(page(OPEN, true), "Create account")).toBe(true);
  });

  it("says when the invite no longer works and offers a sign-in", () => {
    const html = page({ kind: "ended" });

    expect(html).toContain("This invite no longer works.");
    expect(html).not.toContain("Create account");
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>I already have an account<\/a>/u);
  });

  it("offers a retry when the server does not answer", () => {
    expect(page({ kind: "unreachable", retry: () => undefined })).toContain(
      "Can&#x27;t reach the server.",
    );
  });

  it("shows a blank page while looking the invite up", () => {
    expect(page({ kind: "loading" })).toContain('aria-busy="true"');
  });

  it("asks for the link again on a page that no longer holds it", () => {
    const html = renderPage(<MissingLink />);

    expect(html).toContain("Open your link again.");
    expect(html).not.toContain("no longer works");
  });
});

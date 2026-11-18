import { describe, expect, it } from "vitest";

import type { LinkState } from "./link-page";
import { isDisabled, renderPage } from "./render";
import { ResetView } from "./reset";
import type { ResetLink } from "./reset";

const page = (state: LinkState<ResetLink>): string =>
  renderPage(
    <ResetView
      state={state}
      form={{
        password: "",
        submission: { kind: "idle" },
        onPasswordChange: () => undefined,
        onSubmit: () => undefined,
      }}
    />,
  );

describe("ResetView", () => {
  it("names whose password the link sets, read-only, and asks for a new one", () => {
    const html = page({
      kind: "open",
      link: { username: "kim", expiresAt: Date.UTC(2026, 10, 7) },
    });

    expect(html).toMatch(/<input[^>]*readOnly=""[^>]*value="kim"/u);
    expect(html).toContain("New password");
    expect(html).toContain('autoComplete="new-password"');
    expect(isDisabled(html, "Set password")).toBe(false);
  });

  it("says when the link no longer works", () => {
    const html = page({ kind: "ended" });

    expect(html).toContain("This link no longer works.");
    expect(html).not.toContain("Set password");
  });
});

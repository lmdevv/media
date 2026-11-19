import { Brand, Redacted } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";

import { GuestLinksFields } from "./guest-links-form";
import type { GuestLinkButtonProps } from "./guest-links-form";
import type { GuestLinkRow } from "@media/ui/lib/guest-links";
import type { useGuestLinks } from "@media/ui/lib/use-guest-links";

const linkId = Brand.nominal<GuestLinkRow["linkId"]>();

const noop = () => undefined;

const done = () => Promise.resolve();

const Button = ({ tone, ...props }: GuestLinkButtonProps) => <button data-tone={tone} {...props} />;

const Input = (props: ComponentProps<"input">) => <input {...props} />;

const model: ReturnType<typeof useGuestLinks> = {
  expiry: "7",
  setExpiry: noop,
  created: null,
  pending: false,
  made: false,
  copied: false,
  rows: [],
  days: 7,
  create: done,
  revoke: done,
  copy: done,
  loading: false,
  failure: null,
};

const markup = (fields: Partial<typeof model> = {}) =>
  renderToStaticMarkup(
    <GuestLinksFields model={{ ...model, ...fields }} Button={Button} Input={Input} />,
  );

describe("guest link fields", () => {
  it("starts at seven days, bounds the input, and holds create on invalid expiry", () => {
    expect(markup()).toContain('value="7"');
    expect(markup()).toContain('min="1" max="30" step="1"');
    expect(markup({ days: null })).toMatch(/disabled=""[^>]*>Create link/u);
  });

  it("shows a newly created address read-only, and a fresh dialog never recovers it", () => {
    const secret = "http://guest.example/guest#mg_test-secret";
    const created = markup({ created: Redacted.make(secret) });
    expect(created).toContain('readOnly=""');
    expect(created).toContain(secret);
    expect(created).toContain("This link cannot be shown again.");
    expect(markup()).not.toContain(secret);
    expect(markup()).not.toContain("New guest link");
  });

  it("offers revoke only on open links and never displays an address from list metadata", () => {
    const row: GuestLinkRow = {
      linkId: linkId("one"),
      madeBy: "aiko",
      kind: "item",
      domain: "movies",
      target: null,
      state: "open",
      madeAt: 1,
      expiresAt: 10000,
    };

    expect(markup({ rows: [row] })).toContain(">Revoke</button>");

    for (const state of ["revoked", "dead", "expired"] as const) {
      const closed = markup({ rows: [{ ...row, state }] });
      expect(closed).toContain(state);
      expect(closed).not.toContain(">Revoke</button>");
      expect(closed).not.toContain("New guest link");
    }
  });
});

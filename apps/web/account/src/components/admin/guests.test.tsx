import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { ActivityView, GuestSettingsView, GuestsView } from "./guests";
import type { GuestDraft } from "./guests";
import type { Paged } from "@media/ui/lib/pages";
import { disabledButton, loaded, noop, textOf } from "./testing";
import type { GuestLink, GuestStatus, GuestVisit } from "./types";

const linkId = Brand.nominal<GuestLink["linkId"]>();

const guestId = Brand.nominal<GuestVisit["guestId"]>();

const open: GuestLink = {
  linkId: linkId("s1"),
  madeBy: "ada",
  kind: "session",
  domain: "movies",
  target: null,
  state: "open",
  madeAt: 0,
  expiresAt: 0,
};

const revoked: GuestLink = {
  ...open,
  linkId: linkId("s2"),
  kind: "item",
  domain: "music",
  state: "revoked",
};

const links = (list: Paged<GuestLink>, expanded: GuestLink["linkId"] | null = null) => (
  <GuestsView
    settings={<p>settings part</p>}
    links={list}
    open={expanded}
    revoking={null}
    onToggle={noop}
    onRevoke={noop}
    activity={(id) => <p>{`activity of ${id}`}</p>}
  />
);

const on: GuestStatus = { enabled: true, address: "https://media.example.com", mayShare: true };

const settings = (saved: GuestStatus, draft: GuestDraft) => (
  <GuestSettingsView saved={saved} draft={draft} saving={false} onDraft={noop} onSave={noop} />
);

describe("GuestsView", () => {
  it("says when nobody has made a link", () => {
    expect(textOf(links(loaded([])))).toContain("Nobody has made a guest link.");
  });

  it("lists each link with its maker, state, and Revoke only while it is open", () => {
    const text = textOf(links(loaded([open, revoked])));

    expect(text).toContain("ada · Movies group session Open");
    expect(text).toContain("ada · Music item Revoked");
    expect(text.match(/Revoke /gu)?.length).toBe(1);
  });

  it("shows the open link's activity", () => {
    expect(textOf(links(loaded([open]), open.linkId))).toContain(
      "Hide activity Revoke activity of s1",
    );
  });
});

describe("GuestSettingsView", () => {
  it("saves only a change, and needs an address to turn links on", () => {
    expect(disabledButton(settings(on, { enabled: true, address: on.address ?? "" }), "Save")).toBe(
      true,
    );

    const off: GuestStatus = { enabled: false, address: null, mayShare: true };

    expect(disabledButton(settings(off, { enabled: true, address: "" }), "Save")).toBe(true);
    expect(
      disabledButton(settings(off, { enabled: true, address: "https://x.test" }), "Save"),
    ).toBe(false);
  });

  it("warns that turning links off ends every link", () => {
    expect(textOf(settings(on, { enabled: false, address: on.address ?? "" }))).toContain(
      "Every guest link made so far stops working.",
    );
  });
});

describe("ActivityView", () => {
  it("lists who opened a link, or says nobody has", () => {
    expect(textOf(<ActivityView visits={loaded([])} />)).toContain("Nobody has opened it.");
    expect(
      textOf(
        <ActivityView
          visits={loaded([{ guestId: guestId("g1"), name: "Grandma", openedAt: 0 }])}
        />,
      ),
    ).toContain("Grandma opened");
  });
});

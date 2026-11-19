import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { guestLinkDialog } from "./guest-link-dialog";
import type { GuestLinkSelection } from "./guest-link-dialog";

const selection: GuestLinkSelection = {
  name: "Song",
  target: {
    kind: "item",
    item: {
      domain: "music",
      ref: {
        type: "track",
        id: Brand.nominal<
          Extract<
            Extract<GuestLinkSelection["target"]["item"], { domain: "music" }>["ref"],
            { type: "track" }
          >["id"]
        >()("song"),
      },
    },
  },
};

describe("page-owned guest link dialog", () => {
  it("opens from a click without another gate query and never reopens when leave returns", () => {
    const dialog = guestLinkDialog();
    dialog.show(selection);
    expect(dialog.getSnapshot()).toBeNull();
    dialog.setAllowed(true);
    dialog.show(selection);
    expect(dialog.getSnapshot()).toEqual(selection);
    dialog.setAllowed(false);
    expect(dialog.getSnapshot()).toBeNull();
    dialog.setAllowed(true);
    expect(dialog.getSnapshot()).toBeNull();
  });

  it("keeps the chosen song when its row disappears and refuses replacement until closed", () => {
    const dialog = guestLinkDialog();
    dialog.setAllowed(true);
    let rows = [selection];

    for (const row of rows) dialog.show(row);
    rows = [];
    dialog.show({ ...selection, name: "Another song" });
    expect(rows).toHaveLength(0);
    expect(dialog.getSnapshot()).toEqual(selection);
    dialog.close();
    expect(dialog.getSnapshot()).toBeNull();
  });
});

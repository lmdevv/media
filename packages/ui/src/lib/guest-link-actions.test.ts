import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { guestLinkActions } from "./guest-link-actions";
import type { GuestLinkRow, GuestTarget } from "./guest-links";

const linkId = Brand.nominal<GuestLinkRow["linkId"]>()("one");

const target: GuestTarget = {
  kind: "item",
  item: {
    domain: "movies",
    ref: {
      type: "title",
      id: Brand.nominal<
        Extract<Extract<GuestTarget["item"], { domain: "movies" }>["ref"], { type: "title" }>["id"]
      >()("title"),
    },
  },
};

const row: GuestLinkRow = {
  linkId,
  target,
  kind: "item",
  domain: "movies",
  madeBy: "maker",
  state: "open",
  madeAt: 1,
  expiresAt: 10000,
};

const result = { linkId, url: "https://guest.test/guest#unit-secret", expiresAt: 10000 };

const deferred = <A>() => Promise.withResolvers<A>();

function harness(create = () => Promise.resolve(result)) {
  const notices: Array<unknown> = [];
  const copies: Array<string> = [];
  let creates = 0;

  const actions = guestLinkActions(
    target,
    {
      create: () => {
        creates += 1;

        return create();
      },
      revoke: () => Promise.resolve(null),
    },
    (text) => {
      copies.push(text);

      return Promise.resolve();
    },
    {
      copied: () => notices.push("copied"),
      failed: (cause) => notices.push(cause),
    },
  );

  const leave = actions.subscribe(() => undefined);

  return { actions, leave, notices, copies, creates: () => creates };
}

describe("dialog-owned guest link actions", () => {
  it("shows and copies the one-time address only while its own live row is open", async () => {
    const h = harness();
    await h.actions.create();
    expect(h.actions.visible([row]) !== null).toBe(true);
    await h.actions.copy([row]);
    expect(h.copies.length).toBe(1);
    await Promise.all(
      (["revoked", "dead", "expired"] as const).map(async (state) => {
        expect(h.actions.visible([{ ...row, state }])).toBeNull();
        await h.actions.copy([{ ...row, state }]);
      }),
    );
    expect(h.actions.visible([])).toBeNull();
    expect(h.copies.length).toBe(1);
    h.leave();
  });

  it("starts only one create while pending and preserves the answer for its open dialog", async () => {
    const response = deferred<typeof result>();
    const h = harness(() => response.promise);
    const first = h.actions.create();
    await h.actions.create();
    expect(h.creates()).toBe(1);
    expect(h.actions.getSnapshot().pending).toBe(true);
    response.resolve(result);
    await first;
    expect(h.actions.getSnapshot().pending).toBe(false);
    expect(h.actions.visible([row]) !== null).toBe(true);
    h.leave();
  });

  it.each([true, false])(
    "ignores late success=%s after the dialog leaves or changes target",
    async (succeeds) => {
      const response = deferred<typeof result>();
      const h = harness(() => response.promise);
      const creating = h.actions.create();
      h.leave();

      if (succeeds) response.resolve(result);
      else response.reject(new Error("late refusal"));
      await creating;
      expect(h.actions.getSnapshot().newLink).toBeNull();
      expect(h.notices).toEqual([]);
    },
  );
});

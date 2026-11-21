import { TransportError } from "@media/sdk/effect";
import type { QueryState } from "@media/sdk/react";
import { Brand, Redacted } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";

import { GuestLinksFields } from "./guest-links-form";
import type { GuestLinkButtonProps } from "./guest-links-form";
import { guestLinkActions } from "@media/ui/lib/guest-link-actions";
import { pagedStore } from "@media/ui/lib/pages";
import type { PageOf, Watch } from "@media/ui/lib/pages";
import type { GuestLinkRow, GuestTarget } from "@media/ui/lib/guest-links";
import type { useGuestLinks } from "@media/ui/lib/use-guest-links";

const linkId = Brand.nominal<GuestLinkRow["linkId"]>();

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

const watchOf = (initial: QueryState<PageOf<GuestLinkRow>>) => {
  let state = initial;
  const listeners = new Set<() => void>();

  const watch: Watch<PageOf<GuestLinkRow>> = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };

  return {
    watch,
    publish: (next: QueryState<PageOf<GuestLinkRow>>) => {
      state = next;

      for (const listener of listeners) listener();
    },
  };
};

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
  list: { status: "ready", rows: [], next: { kind: "done" } },
  days: 7,
  create: done,
  revoke: done,
  copy: done,
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

  it("names each field by its label and announces loading as a status", () => {
    const created = markup({ created: Redacted.make("http://guest.example/guest#mg_secret") });

    expect(markup()).toMatch(
      /<label for="([^"]+)"[^>]*><span>Expires in days<\/span><input id="\1"/u,
    );
    expect(created).toMatch(
      /<label for="([^"]+)"[^>]*><span>New guest link<\/span><input id="\1"/u,
    );
    expect(markup({ list: { status: "loading" } })).toMatch(
      /<output[^>]*>Loading links…<\/output>/u,
    );
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
    expect(markup({ list: { status: "ready", rows: [row], next: { kind: "done" } } })).toContain(
      ">Revoke</button>",
    );

    for (const state of ["revoked", "dead", "expired"] as const) {
      const closed = markup({
        list: { status: "ready", rows: [{ ...row, state }], next: { kind: "done" } },
      });

      expect(closed).toContain(state);
      expect(closed).not.toContain(">Revoke</button>");
      expect(closed).not.toContain("New guest link");
    }
  });
});

describe("paged guest link fields", () => {
  it("loads older rows with Show more and revokes an open link on the second page", async () => {
    const target: GuestTarget = {
      kind: "item",
      item: {
        domain: "movies",
        ref: {
          type: "title",
          id: Brand.nominal<
            Extract<
              Extract<GuestTarget["item"], { domain: "movies" }>["ref"],
              { type: "title" }
            >["id"]
          >()("title"),
        },
      },
    };

    const firstRows = Array.from({ length: 25 }, (_, index) => ({
      ...row,
      linkId: linkId(`recent-${index}`),
      state: "revoked" as const,
    }));

    const first = watchOf({
      status: "success",
      data: { page: firstRows, isDone: false, continueCursor: "older" },
    });

    const second = watchOf({ status: "loading" });
    const store = pagedStore(({ cursor }) => (cursor === null ? first.watch : second.watch));
    const stop = store.subscribe(noop);
    const revoked: Array<GuestLinkRow["linkId"]> = [];

    const actions = guestLinkActions(
      target,
      {
        create: () =>
          Promise.resolve({
            linkId: row.linkId,
            url: "https://guest.test/guest#unit-secret",
            expiresAt: row.expiresAt,
          }),
        revoke: ({ linkId: id }) => {
          revoked.push(id);
          second.publish({
            status: "success",
            data: { page: [{ ...row, state: "revoked" }], isDone: true, continueCursor: "" },
          });

          return Promise.resolve(null);
        },
      },
      () => Promise.resolve(),
      { copied: noop, failed: noop },
    );

    const leave = actions.subscribe(noop);
    const before = store.getSnapshot();
    expect(markup({ list: before })).toContain(">Show more</button>");
    expect(markup({ list: before })).not.toContain(">Revoke</button>");

    if (before.status !== "ready" || before.next.kind !== "more")
      throw new Error("expected more guest links");
    const buttons: Array<GuestLinkButtonProps> = [];

    const controls = (props: GuestLinkButtonProps) => {
      buttons.push(props);

      return <Button {...props} />;
    };

    renderToStaticMarkup(
      <GuestLinksFields model={{ ...model, list: before }} Button={controls} Input={Input} />,
    );
    expect(buttons.find((props) => props.children === "Show more")?.onClick).toBe(before.next.load);
    before.next.load();
    expect(markup({ list: store.getSnapshot() })).toContain("Loading links…");
    expect(markup({ list: store.getSnapshot() }).match(/<li /gu)).toHaveLength(25);

    second.publish({ status: "success", data: { page: [row], isDone: true, continueCursor: "" } });
    const loaded = store.getSnapshot();
    expect(markup({ list: loaded }).match(/<li /gu)).toHaveLength(26);
    expect(markup({ list: loaded })).toContain(">Revoke</button>");
    expect(markup({ list: loaded })).not.toContain("Show more");
    await actions.create();
    const rows = loaded.status === "ready" ? loaded.rows : [];
    expect(actions.visible(rows) !== null).toBe(true);
    await actions.copy(rows);
    expect(actions.getSnapshot().copied).toBe(true);
    await actions.revoke(row.linkId);
    expect(revoked).toEqual([row.linkId]);
    expect(markup({ list: store.getSnapshot() })).not.toContain(">Revoke</button>");
    expect(actions.visible(rows)).toBeNull();
    leave();
    stop();
  });

  it("keeps earlier rows when the next page fails and offers retry", () => {
    let retries = 0;

    const first = watchOf({
      status: "success",
      data: { page: [row], isDone: false, continueCursor: "older" },
    });

    const second = watchOf({ status: "loading" });
    const store = pagedStore(({ cursor }) => (cursor === null ? first.watch : second.watch));
    const stop = store.subscribe(noop);
    const before = store.getSnapshot();

    if (before.status !== "ready" || before.next.kind !== "more")
      throw new Error("expected more guest links");
    before.next.load();

    const retry = () => {
      retries += 1;
      second.publish({
        status: "success",
        data: { page: [{ ...row, linkId: linkId("older") }], isDone: true, continueCursor: "" },
      });
    };

    second.publish({
      status: "error",
      error: new TransportError({
        operation: "guests.links.list",
        message: "Could not load older links",
        cause: null,
      }),
      retry,
    });
    const list = store.getSnapshot();
    const rendered = markup({ list });
    expect(rendered).toContain(">Revoke</button>");
    expect(rendered).toContain('role="alert"');
    expect(rendered).toContain("Can&#x27;t reach the server. Check the connection and try again.");
    expect(rendered).toContain(">Try again</button>");
    expect(rendered).not.toContain("No guest links yet.");

    if (list.status !== "ready" || list.next.kind !== "failed")
      throw new Error("expected a failed older page");
    list.next.retry();
    expect(retries).toBe(1);
    expect(markup({ list: store.getSnapshot() }).match(/<li /gu)).toHaveLength(2);
    stop();
    expect(
      markup({
        list: {
          status: "failed",
          message: "Could not load links",
          error: new TransportError({
            operation: "guests.links.list",
            message: "Could not load links",
            cause: null,
          }),
          retry,
        },
      }),
    ).toContain("Could not load links");
    expect(markup({ list: { status: "loading" } })).toContain("Loading links…");
  });
});

import { holdGuestSignIn } from "@media/sdk/promise";
import { jwtExpiringAt } from "@media/sdk/testing/fake-convex";
import { describe, expect, it } from "vitest";

import { makeBrowserTabs } from "./testing/browser-tabs";

const tokens = (id: string): string =>
  JSON.stringify({
    token: jwtExpiringAt(Date.now() + 3_600_000, id),
    refreshToken: `refresh-${id}`,
  });

describe("guest browser handoff", () => {
  it("keeps only tokens and preserves the browser's device", async () => {
    const tabs = await makeBrowserTabs({ count: 1, delivery: "at once" });
    const store = tabs.tab(0);
    await store.write(async (tx) => {
      await tx.set("media.device", "device-record");
    });
    const held = await holdGuestSignIn(store);
    const guest = tokens("guest|session");
    await held.storage.setItem("media.session", guest);
    expect(await held.keep()).toBe(true);
    const items = await tabs.items();
    expect(items.get("media.device")).toBe("device-record");
    expect(items.get("media.session")).toBe(guest);
    expect([...items.keys()]).toEqual(["media.device", "media.session"]);
  });
  it("does not change the member's session while a redemption is held or cancelled", async () => {
    const tabs = await makeBrowserTabs({ count: 1, delivery: "at once" });
    const store = tabs.tab(0);
    const member = tokens("member|session");
    await store.write((tx) => tx.set("media.session", member));
    const held = await holdGuestSignIn(store);
    await held.storage.setItem("media.session", tokens("guest|session"));
    expect((await tabs.items()).get("media.session")).toBe(member);
    expect(await held.keep()).toBe(true);
    expect((await tabs.items()).get("media.revoked:member|session")).toBe("revoked");
  });
  it("accepts a renewal of the same session and revokes its current tokens", async () => {
    const tabs = await makeBrowserTabs({ count: 1, delivery: "at once" });
    const store = tabs.tab(0);
    await store.write((tx) => tx.set("media.session", tokens("member|session")));
    const held = await holdGuestSignIn(store);

    const renewed = JSON.stringify({
      token: jwtExpiringAt(Date.now() + 7_200_000, "member|session"),
      refreshToken: "renewed",
    });

    await store.write((tx) => tx.set("media.session", renewed));
    await held.storage.setItem("media.session", tokens("guest|session"));
    expect(await held.keep()).toBe(true);
    expect(await held.keep()).toBe(true);
    expect((await tabs.items()).get("media.signOut:member|session")).toBe(renewed);
  });

  it("never overwrites a sign-in another tab changed during redemption", async () => {
    const tabs = await makeBrowserTabs({ count: 2, delivery: "at once" });
    const held = await holdGuestSignIn(tabs.tab(0));
    await held.storage.setItem("media.session", tokens("guest|session"));
    const other = tokens("member|other");
    await tabs.tab(1).write((tx) => tx.set("media.session", other));
    expect(await held.keep()).toBe(false);
    expect((await tabs.items()).get("media.session")).toBe(other);
    expect((await tabs.items()).get("media.revoked:guest|session")).toBe("revoked");
  });
});

import { describe, expect, it } from "vitest";

import { linkSecretFor, secretLink, showsLinkSecret, takeLinkSecret } from "./link-secret";

const tabAt = (url: string) => {
  const entries = [new URL(url)];

  const address = () => entries.at(-1) ?? new URL(url);

  return {
    address,
    entries: () => entries.map((entry) => entry.href),
    history: {
      state: null,
      replaceState: (_state, _unused, next) => {
        entries.splice(-1, 1, new URL(next ?? address().href, address()));
      },
    } satisfies Pick<History, "state" | "replaceState">,
  };
};

describe("link secrets", () => {
  it("builds a link whose secret no request carries", () => {
    const link = new URL(secretLink("https://media.test", "/invite", "mi_1.secret"));

    expect({ path: link.pathname, search: link.search, hash: link.hash }).toStrictEqual({
      path: "/invite",
      search: "",
      hash: "#mi_1.secret",
    });
  });

  it("takes an invite's secret into memory and leaves the bare page in history", () => {
    const tab = tabAt(secretLink("https://media.test", "/invite", "mi_1.secret"));
    const held = takeLinkSecret(tab.address(), tab.history);

    expect({ held, history: tab.entries() }).toStrictEqual({
      held: { page: "/invite", secret: "mi_1.secret" },
      history: ["https://media.test/invite"],
    });
    expect(linkSecretFor(held, "/invite")).toBe("mi_1.secret");
    expect(linkSecretFor(held, "/reset")).toBe("");
  });

  it("takes a reset link's secret the same way", () => {
    const tab = tabAt("https://media.test/reset#mr_2.secret");

    expect(takeLinkSecret(tab.address(), tab.history)).toStrictEqual({
      page: "/reset",
      secret: "mr_2.secret",
    });
    expect(tab.entries()).toStrictEqual(["https://media.test/reset"]);
  });

  it("leaves other pages and bare link pages alone", () => {
    for (const url of [
      "https://media.test/home#section",
      "https://media.test/device?code=ABCDEFGH",
      "https://media.test/invite",
      "https://media.test/invite#",
    ]) {
      const tab = tabAt(url);

      expect(takeLinkSecret(tab.address(), tab.history)).toBeNull();
      expect(showsLinkSecret(tab.address())).toBe(false);
      expect(tab.entries()).toStrictEqual([new URL(url).href]);
    }
  });
});

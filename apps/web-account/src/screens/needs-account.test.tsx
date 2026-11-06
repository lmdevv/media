import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import type { Me } from "@/session/platform-types";

import { renderPage } from "./entry/render";
import { NeedsAccountScreen } from "./needs-account";

const me = (scopes: Me["scopes"], kind: Me["kind"]): Me => ({
  userId: Brand.nominal<Me["userId"]>()("u1"),
  username: "kim",
  role: "member",
  sessionId: Brand.nominal<Me["sessionId"]>()("s1"),
  kind,
  scopes,
});

describe("NeedsAccountScreen", () => {
  it("sends a tile session to its own device", () => {
    const html = renderPage(<NeedsAccountScreen me={me(["movies:read"], "tile")} admin={false} />);

    expect(html).toContain("Use your own device.");
    expect(html).toContain("kim is open as a tile on this shared device.");
    expect(html).toMatch(/<a [^>]*href="\/home"[^>]*>Go to Home<\/a>/u);
  });

  it("tells a member that admin is not theirs", () => {
    const html = renderPage(<NeedsAccountScreen me={me(["account"], "password")} admin />);

    expect(html).toContain("Only admins can open this.");
    expect(html).toContain("kim isn&#x27;t an admin on this server.");
    expect(html).toMatch(/<a [^>]*href="\/home"[^>]*>Go to Home<\/a>/u);
  });
});

import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { Brand } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Me } from "@/session/platform-types";

import { HomeView } from "./home";

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/home"] }),
});

const render = (me: Me): string =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <HomeView me={me} />
    </RouterContextProvider>,
  );

const person = (kind: Me["kind"], scopes: Me["scopes"]): Me => ({
  userId: Brand.nominal<Me["userId"]>()("u1"),
  username: "ana",
  displayName: null,
  role: "member",
  sessionId: Brand.nominal<Me["sessionId"]>()("s1"),
  kind,
  scopes,
  device: null,
});

const hrefs = (html: string): ReadonlyArray<string> =>
  [...html.matchAll(/<a [^>]*href="([^"]*)"/gu)].map((match) => match[1] ?? "");

describe("HomeView", () => {
  it("greets a member and links the products and their settings", () => {
    const html = render(person("password", ["account", "movies:play", "music:play"]));

    expect(html).toContain("Hi, ana.");
    expect(hrefs(html)).toEqual(["/movies", "/music", "/settings"]);
  });

  it("greets by the name the person goes by when they set one", () => {
    const html = render({
      ...person("password", ["account"]),
      displayName: "Ana Lima",
    });

    expect(html).toContain("Hi, Ana Lima.");
  });

  it("adds Admin for an admin", () => {
    const html = render(person("password", ["account", "admin"]));

    expect(hrefs(html)).toEqual(["/movies", "/music", "/settings", "/admin"]);
  });

  it("offers a tile session only the products and switching person", () => {
    const html = render(person("tile", ["movies:play", "music:play"]));

    expect(hrefs(html)).toEqual(["/movies", "/music", "/"]);
    expect(html).toContain("Switch person");
    expect(html).not.toContain("Settings");
  });
});

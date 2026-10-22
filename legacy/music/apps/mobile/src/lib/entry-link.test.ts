import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { entryPath, linkIsFor, parseEntryLink } from "./entry-link";
import { ServerOrigin } from "./server";

const origin = Schema.decodeSync(ServerOrigin);

describe("parseEntryLink", () => {
  it("reads the app's own links, which name no server unless asked", () => {
    expect(parseEntryLink("music://invite/abc23xyz9k")).toEqual({
      kind: "invite",
      secret: "abc23xyz9k",
      server: null,
    });
    expect(parseEntryLink("music:///reset/tok_en-1/")).toEqual({
      kind: "reset",
      secret: "tok_en-1",
      server: null,
    });
    expect(parseEntryLink("music://invite/abc?server=http%3A%2F%2F100.94.55.81%3A8091")).toEqual({
      kind: "invite",
      secret: "abc",
      server: "http://100.94.55.81:8091",
    });
  });

  it("reads Jam links, the app's own and the web's", () => {
    expect(parseEntryLink("music://jam/k3j9x")).toEqual({
      kind: "jam",
      secret: "k3j9x",
      server: null,
    });
    expect(parseEntryLink("http://100.94.55.81:8091/jam/k3j9x")).toEqual({
      kind: "jam",
      secret: "k3j9x",
      server: "http://100.94.55.81:8091",
    });
  });

  it("reads a route path as the connected server's link", () => {
    expect(parseEntryLink("/invite/abc")).toEqual({ kind: "invite", secret: "abc", server: null });
  });

  it("reads web links, pasted with or without a scheme, under a path prefix too", () => {
    expect(parseEntryLink(" http://100.94.55.81:8091/invite/abc23xyz9k ")).toEqual({
      kind: "invite",
      secret: "abc23xyz9k",
      server: "http://100.94.55.81:8091",
    });
    expect(parseEntryLink("music.example/reset/tok?x=1")).toEqual({
      kind: "reset",
      secret: "tok",
      server: "music.example",
    });
    expect(parseEntryLink("https://home.example/music/invite/abc/")).toMatchObject({
      server: "https://home.example/music",
    });
  });

  it("is not fooled by other links or bad secrets", () => {
    expect(parseEntryLink("https://music.example")).toBeNull();
    expect(parseEntryLink("https://music.example/albums/abc")).toBeNull();
    expect(parseEntryLink("music://playlist/abc")).toBeNull();
    expect(parseEntryLink("music://invite/a%2Fb")).toBeNull();
    expect(parseEntryLink("music://invite/%E0%A4%A")).toBeNull();
    expect(parseEntryLink("ftp://music.example/invite/abc")).toBeNull();
  });
});

describe("entryPath", () => {
  it("opens the link's screen", () => {
    expect(entryPath({ kind: "reset", secret: "tok", server: null }, false)).toBe("/reset/tok");
  });

  it("opens a Jam link as a guest signed out, and as its invite signed in", () => {
    const jam = { kind: "jam", secret: "k3j9", server: null } as const;

    expect(entryPath(jam, false)).toBe("/jam-guest/k3j9");
    expect(entryPath(jam, true)).toBe("/jam/k3j9");
  });

  it("has nothing for invites and resets once signed in", () => {
    expect(entryPath({ kind: "invite", secret: "a", server: null }, true)).toBeNull();
  });
});

describe("linkIsFor", () => {
  const home = origin("http://100.94.55.81:8091");

  it("matches the server the link names, or any when it names none", () => {
    expect(linkIsFor({ kind: "invite", secret: "a", server: null }, home)).toBe(true);
    expect(
      linkIsFor({ kind: "invite", secret: "a", server: "http://100.94.55.81:8091" }, home),
    ).toBe(true);
    expect(linkIsFor({ kind: "invite", secret: "a", server: "100.94.55.81:8091" }, home)).toBe(
      true,
    );
    expect(linkIsFor({ kind: "invite", secret: "a", server: "https://music.example" }, home)).toBe(
      false,
    );
  });
});

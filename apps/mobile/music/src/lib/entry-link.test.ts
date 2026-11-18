import { describe, expect, it } from "vitest";

import { entryPath, linkIsFor, parseEntryLink } from "./entry-link";

describe("parseEntryLink", () => {
  it("reads the app's own links, which name no server unless asked", () => {
    expect(parseEntryLink("music://invite/mi_abc.23xyz9k")).toEqual({
      kind: "invite",
      secret: "mi_abc.23xyz9k",
      server: null,
    });
    expect(parseEntryLink("music:///reset/mr_tok.en-1/")).toEqual({
      kind: "reset",
      secret: "mr_tok.en-1",
      server: null,
    });
    expect(parseEntryLink("music://invite/abc?server=http%3A%2F%2F100.94.55.81%3A8091")).toEqual({
      kind: "invite",
      secret: "abc",
      server: "http://100.94.55.81:8091",
    });
  });

  it("reads a route path as the connected server's link", () => {
    expect(parseEntryLink("/invite/abc")).toEqual({ kind: "invite", secret: "abc", server: null });
  });

  it("reads the account client's links, the code after #, with or without a scheme", () => {
    expect(parseEntryLink(" http://100.94.55.81:8091/invite#mi_abc.23xyz9k ")).toEqual({
      kind: "invite",
      secret: "mi_abc.23xyz9k",
      server: "http://100.94.55.81:8091",
    });
    expect(parseEntryLink("music.example/reset#mr_tok.x")).toEqual({
      kind: "reset",
      secret: "mr_tok.x",
      server: "music.example",
    });
    expect(parseEntryLink("https://home.example/media/invite/#abc")).toMatchObject({
      server: "https://home.example/media",
    });
  });

  it("refuses old path links, as the account client does", () => {
    expect(parseEntryLink("http://100.94.55.81:8091/invite/abc23xyz9k")).toBeNull();
  });

  it("is not fooled by other links or bad codes", () => {
    expect(parseEntryLink("https://music.example")).toBeNull();
    expect(parseEntryLink("https://music.example/albums/abc")).toBeNull();
    expect(parseEntryLink("music://playlist/abc")).toBeNull();
    expect(parseEntryLink("music://jam/k3j9x")).toBeNull();
    expect(parseEntryLink("music://invite/a%2Fb")).toBeNull();
    expect(parseEntryLink("music://invite/%E0%A4%A")).toBeNull();
    expect(parseEntryLink("ftp://music.example/invite#abc")).toBeNull();
  });
});

describe("entryPath", () => {
  it("opens the link's screen", () => {
    expect(entryPath({ kind: "reset", secret: "tok", server: null })).toBe("/reset/tok");
    expect(entryPath({ kind: "invite", secret: "mi_a.b", server: null })).toBe("/invite/mi_a.b");
  });
});

describe("linkIsFor", () => {
  const home = "http://100.94.55.81:8091";

  it("takes a link without a server as the connected one's", () => {
    expect(linkIsFor({ kind: "invite", secret: "a", server: null }, home)).toBe(true);
  });

  it("matches the server a link names, with or without its scheme", () => {
    expect(linkIsFor({ kind: "invite", secret: "a", server: "100.94.55.81:8091" }, home)).toBe(
      true,
    );
    expect(linkIsFor({ kind: "invite", secret: "a", server: home }, home)).toBe(true);
    expect(linkIsFor({ kind: "invite", secret: "a", server: "music.example" }, home)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { parseInviteLink, sameServer } from "./invite-link";

describe("invite links", () => {
  it("reads the account client's invite links, with the code in the fragment", () => {
    expect(parseInviteLink("https://cinema.home/invite#mi_abc.123")).toEqual({
      server: "https://cinema.home",
      code: "mi_abc.123",
    });
    expect(parseInviteLink(" http://192.168.1.20:8080/invite#mi_abc.123 ")).toEqual({
      server: "http://192.168.1.20:8080",
      code: "mi_abc.123",
    });
    expect(parseInviteLink("cinema.home/invite#mi_abc.123")).toEqual({
      server: "cinema.home",
      code: "mi_abc.123",
    });
  });

  it("refuses old path links, as the account client does", () => {
    expect(parseInviteLink("https://cinema.home/invite/abc123")).toBeNull();
  });

  it("reads the app's deep links", () => {
    expect(
      parseInviteLink("movies://invite?server=http%3A%2F%2F127.0.0.1%3A13322&code=abc123"),
    ).toEqual({ server: "http://127.0.0.1:13322", code: "abc123" });
    expect(parseInviteLink("movies://invite/abc123?server=cinema.home")).toEqual({
      server: "cinema.home",
      code: "abc123",
    });
  });

  it("refuses text that is not an invite link", () => {
    expect(parseInviteLink("")).toBeNull();
    expect(parseInviteLink("abc123")).toBeNull();
    expect(parseInviteLink("https://cinema.home/device?code=BCDF")).toBeNull();
    expect(parseInviteLink("movies://invite?code=abc123")).toBeNull();
    expect(parseInviteLink("movies://invite?server=cinema.home")).toBeNull();
    expect(parseInviteLink("movies://room?server=cinema.home&code=1")).toBeNull();
  });

  it("compares servers by their normalized address", () => {
    expect(sameServer("https://cinema.home/", "cinema.home")).toBe(true);
    expect(sameServer("http://cinema.home", "https://cinema.home")).toBe(false);
    expect(sameServer("http://127.0.0.1:13322", "127.0.0.1:13322")).toBe(true);
    expect(sameServer("http://127.0.0.1:13322", "127.0.0.1:13323")).toBe(false);
  });
});

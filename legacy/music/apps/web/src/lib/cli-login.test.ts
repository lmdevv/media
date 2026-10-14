import { describe, expect, it } from "vitest";

import { cliLoginCommand, needsInsecure } from "./cli-login";

describe("needsInsecure", () => {
  it("asks for --insecure only for plain http:// to another machine", () => {
    expect(needsInsecure("http://192.168.1.20:8090/convex")).toBe(true);
    expect(needsInsecure("http://music.lan/convex")).toBe(true);
    expect(needsInsecure("https://music.example.com/convex")).toBe(false);
    expect(needsInsecure("http://127.0.0.1:3210")).toBe(false);
    expect(needsInsecure("http://localhost:8090/convex")).toBe(false);
    expect(needsInsecure("http://[::1]:8090/convex")).toBe(false);
  });
});

describe("cliLoginCommand", () => {
  it("pipes the key in, adding --insecure where the CLI would refuse", () => {
    expect(cliLoginCommand("https://music.example.com/convex")).toBe(
      `printf '%s' "$KEY" | music login --server 'https://music.example.com/convex' --key-stdin`,
    );
    expect(cliLoginCommand("http://music.lan/convex")).toBe(
      `printf '%s' "$KEY" | music login --server 'http://music.lan/convex' --insecure --key-stdin`,
    );
  });

  it("quotes the server so a ?, &, or ' in it stays one word", () => {
    expect(cliLoginCommand("https://music.example.com/convex?a=1&b=it's")).toBe(
      `printf '%s' "$KEY" | music login --server 'https://music.example.com/convex?a=1&b=it'\\''s' --key-stdin`,
    );
  });
});

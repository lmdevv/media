import { describe, expect, it } from "vitest";

import { displayHost, isLocalNetworkUrl } from "./local-network";

describe("local network", () => {
  it("recognizes addresses on this network", () => {
    expect(isLocalNetworkUrl("http://192.168.1.20:8080")).toBe(true);
    expect(isLocalNetworkUrl("http://10.0.0.5")).toBe(true);
    expect(isLocalNetworkUrl("http://172.20.1.1")).toBe(true);
    expect(isLocalNetworkUrl("http://nas.local:8096")).toBe(true);
    expect(isLocalNetworkUrl("http://nas")).toBe(true);
    expect(isLocalNetworkUrl("http://[fd12:3456::1]:8080")).toBe(true);
  });

  it("leaves out loopback and the internet", () => {
    expect(isLocalNetworkUrl("http://127.0.0.1:13322")).toBe(false);
    expect(isLocalNetworkUrl("http://localhost:3000")).toBe(false);
    expect(isLocalNetworkUrl("https://cinema.example.com")).toBe(false);
    expect(isLocalNetworkUrl("http://172.32.0.1")).toBe(false);
    expect(isLocalNetworkUrl("https://100.64.0.1")).toBe(false);
  });

  it("shows the host people recognize", () => {
    expect(displayHost("https://cinema.home")).toBe("cinema.home");
    expect(displayHost("http://192.168.1.20:8080/movies")).toBe("192.168.1.20:8080");
  });
});

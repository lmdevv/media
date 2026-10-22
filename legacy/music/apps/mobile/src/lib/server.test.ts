import { describe, expect, it } from "vitest";

import { connectionFor, discoverServer, displayHost, originCandidates } from "./server";
import type { Fetch } from "./server";

/** A network where each origin answers its health check one way, and the rest is unreachable. */
const network =
  (answers: Readonly<Record<string, () => Response>>): Fetch =>
  async (url) => {
    const origin = new URL(url).origin;
    const answer = answers[origin];

    if (answer === undefined) throw new TypeError("Network request failed");

    return answer();
  };

const healthy = () => Response.json({ ok: true, convex: true, ffmpeg: true, version: "0.3.0" });

const page = () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } });

const down = () => Response.json({ ok: false, convex: false, ffmpeg: true }, { status: 503 });

describe("originCandidates", () => {
  it("tries only https for a public name typed without a scheme", () => {
    expect(originCandidates(" music.example ")).toEqual(["https://music.example"]);
  });

  it("tries https, then http, for a home network or tailnet host", () => {
    expect(originCandidates("192.168.1.4:8090")).toEqual([
      "https://192.168.1.4:8090",
      "http://192.168.1.4:8090",
    ]);
    expect(originCandidates("100.94.55.81:8090")).toEqual([
      "https://100.94.55.81:8090",
      "http://100.94.55.81:8090",
    ]);
    expect(originCandidates("nas.local")).toEqual(["https://nas.local", "http://nas.local"]);
    expect(originCandidates("music.tail0f3747.ts.net")).toHaveLength(2);
    expect(originCandidates("nas")).toHaveLength(2);
    expect(originCandidates("[fd7a:115c:a1e0::1]:8090")).toHaveLength(2);
    expect(originCandidates("8.8.8.8")).toEqual(["https://8.8.8.8"]);
    expect(originCandidates("172.32.0.1")).toEqual(["https://172.32.0.1"]);
  });

  it("keeps a typed scheme and port", () => {
    expect(originCandidates("http://100.94.55.81:8090/")).toEqual(["http://100.94.55.81:8090"]);
  });

  it("drops a pasted Convex path", () => {
    expect(originCandidates("https://music.example/convex")).toEqual(["https://music.example"]);
  });

  it("refuses text that is not an http address", () => {
    expect(originCandidates("")).toBeNull();
    expect(originCandidates("ftp://music.example")).toBeNull();
    expect(originCandidates("not a host")).toBeNull();
  });
});

describe("discoverServer", () => {
  it("connects to the server's Convex under /convex", async () => {
    const result = await discoverServer(
      "music.example",
      network({ "https://music.example": healthy }),
    );

    expect(result).toEqual({
      ok: true,
      connection: { origin: "https://music.example", convexUrl: "https://music.example/convex" },
    });
  });

  it("falls back to http when https does not answer", async () => {
    const result = await discoverServer(
      "100.94.55.81:8090",
      network({ "http://100.94.55.81:8090": healthy }),
    );

    expect(result).toEqual({
      ok: true,
      connection: connectionFor(originAt("http://100.94.55.81:8090")),
    });
  });

  it("reports an address nothing answers at", async () => {
    expect(await discoverServer("music.example", network({}))).toEqual({
      ok: false,
      failure: "unreachable",
    });
  });

  it("reports a web page that is not a [music] server", async () => {
    expect(
      await discoverServer("https://example.com", network({ "https://example.com": page })),
    ).toEqual({ ok: false, failure: "notMusic" });
  });

  it("reports a [music] server whose Convex is down", async () => {
    expect(
      await discoverServer("music.example", network({ "https://music.example": down })),
    ).toEqual({ ok: false, failure: "unhealthy" });
  });

  it("refuses text that is not an address", async () => {
    expect(await discoverServer("  ", network({}))).toEqual({ ok: false, failure: "invalid" });
  });
});

describe("displayHost", () => {
  it("drops the scheme", () => {
    expect(displayHost(originAt("http://100.94.55.81:8090"))).toBe("100.94.55.81:8090");
  });
});

/** The single origin typed text with a scheme names. */
function originAt(text: string) {
  const [origin] = originCandidates(text) ?? [];

  if (origin === undefined) throw new Error(`${text} is not an origin`);

  return origin;
}

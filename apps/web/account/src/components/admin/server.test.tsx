import { describe, expect, it } from "vitest";

import { ServerView } from "./server";
import type { ServerState } from "./server";
import { noop, textOf } from "./testing";
import type { ServerStatus } from "./types";

const NOW = Date.UTC(2026, 10, 10, 12);

const MINUTE_MS = 60 * 1000;

const gpu = {
  node: "renderD128",
  opened: true,
  pci: "8086:56a5 rev 05",
  kernelDriver: "i915",
  userDriver: "Intel iHD driver 26.3.5",
  checkedAt: NOW - 60 * MINUTE_MS,
};

const capability = (
  key: string,
  status: "unknown" | "verified" | "unsupported",
  quarantineEndsAt: number | "restart" | null = null,
) => ({
  key,
  domain: key.slice(key.indexOf(".") + 1, key.indexOf(":")),
  status,
  source: "probe" as const,
  checkedAt: NOW - 50 * MINUTE_MS,
  detail: status === "verified" ? "passed" : "rejected: Error querying IO surface",
  quarantineEndsAt,
});

type Transcoding = NonNullable<ServerStatus>["transcoding"];

const transcoding: Transcoding = {
  build: { version: "9.0.2", kernel: "6.18.63", checkedAt: NOW - 60 * MINUTE_MS },
  devices: [
    { ...gpu, domain: "qsv" },
    { ...gpu, domain: "vaapi" },
  ],
  capabilities: [
    capability("decode.qsv:h264/yuv420p", "verified"),
    capability("decode.qsv:h264/yuv420p10le", "unsupported"),
    capability("encode.qsv:h264/8/cbr", "verified"),
    capability("scale.qsv:8>8", "verified"),
    capability("tonemap.qsv:pq", "verified", NOW + 15 * MINUTE_MS),
    capability("tonemap.vaapi:pq", "verified", NOW - MINUTE_MS),
  ],
};

const reported: NonNullable<ServerStatus> = {
  version: "0.4.1",
  activeStreams: 2,
  runsAwaitingExit: 1,
  startedAt: NOW - 60 * MINUTE_MS,
  reportedAt: NOW - MINUTE_MS,
  transcoding,
};

const server = (state: ServerState, databaseVersion: string | null = "0.2.0") => (
  <ServerView
    state={state}
    databaseVersion={databaseVersion}
    mediaUrl="https://media.example.com"
    databaseUrl="https://media.example.com/convex"
    now={NOW}
  />
);

describe("ServerView", () => {
  it("shows a running server's GPU, its capabilities, its streams, and its addresses", () => {
    const text = textOf(server({ kind: "ready", status: reported }));

    expect(text).toContain("media.example.com · media service running");
    expect(text).toContain(
      "Hardware transcoding Detected 8086:56a5 rev 05 · i915 · QSV, VA-API · Intel iHD driver 26.3.5",
    );
    expect(text, "a quarantine that ended no longer counts").toContain(
      "5 verified 1 unsupported 1 quarantined",
    );
    expect(text).toContain("tonemap.qsv:pq · until");
    expect(text).not.toContain("tonemap.vaapi:pq");
    expect(text).toContain("Playing now 2");
    expect(text).toContain("Streams stopping 1");
    expect(text).toContain("Media service https://media.example.com · 0.4.1");
    expect(text).toContain("Database https://media.example.com/convex · 0.2.0");
  });

  it("says CPU only when the server found no GPU, and not opened for one ffmpeg could not open", () => {
    const cpuOnly = textOf(
      server({
        kind: "ready",
        status: { ...reported, transcoding: { ...transcoding, devices: [], capabilities: [] } },
      }),
    );

    expect(cpuOnly).toContain("Not detected CPU only 0 verified 0 unsupported");
    expect(cpuOnly).not.toContain("quarantined");

    const closed = textOf(
      server({
        kind: "ready",
        status: {
          ...reported,
          transcoding: {
            ...transcoding,
            devices: [{ ...gpu, domain: "qsv", opened: false, userDriver: null }],
          },
        },
      }),
    );

    expect(closed).toContain("Not detected 8086:56a5 rev 05 · i915 · not opened");
  });

  it("names a quarantine that lasts until the server restarts", () => {
    const text = textOf(
      server({
        kind: "ready",
        status: {
          ...reported,
          transcoding: {
            ...transcoding,
            capabilities: [capability("encode.qsv:h264/8/cbr", "verified", "restart")],
          },
        },
      }),
    );

    expect(text).toContain("encode.qsv:h264/8/cbr · until restart");
  });

  it("calls a server that stopped reporting not responding", () => {
    const text = textOf(
      server({ kind: "ready", status: { ...reported, reportedAt: NOW - 11 * MINUTE_MS } }),
    );

    expect(text).toContain("media service not responding");
    expect(text).toContain("Unknown");
    expect(text).toContain("Playing now —");
  });

  it("says when the media service never reported", () => {
    const text = textOf(server({ kind: "ready", status: null }, null));

    expect(text).toContain("media service has not reported");
    expect(text).toContain("Media service https://media.example.com Running since —");
    expect(text).toContain("Database https://media.example.com/convex");
  });

  it("shows a failure with Try again", () => {
    expect(textOf(server({ kind: "failed", message: "Offline", retry: noop }))).toContain(
      "Offline Try again",
    );
  });
});

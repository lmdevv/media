import { describe, expect, it } from "vitest";

import { ServerView } from "./server";
import type { ServerState } from "./server";
import { noop, textOf } from "./testing";
import type { ServerStatus } from "./types";

const NOW = Date.UTC(2026, 10, 10, 12);

const MINUTE_MS = 60 * 1000;

const reported: NonNullable<ServerStatus> = {
  version: "0.3.0",
  hardwareAcceleration: "qsv",
  activeStreams: 2,
  runsAwaitingExit: 1,
  startedAt: NOW - 60 * MINUTE_MS,
  reportedAt: NOW - MINUTE_MS,
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
  it("shows a running server's transcoding, streams, and addresses", () => {
    const text = textOf(server({ kind: "ready", status: reported }));

    expect(text).toContain("media.example.com · media service running");
    expect(text).toContain("Hardware transcoding Detected Intel Quick Sync");
    expect(text).toContain("Playing now 2");
    expect(text).toContain("Streams stopping 1");
    expect(text).toContain("Media service https://media.example.com · 0.3.0");
    expect(text).toContain("Database https://media.example.com/convex · 0.2.0");
  });

  it("says software encoding when no hardware encoder is found", () => {
    const text = textOf(
      server({ kind: "ready", status: { ...reported, hardwareAcceleration: "none" } }),
    );

    expect(text).toContain("Not detected Software encoding with ffmpeg");
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

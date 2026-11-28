import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import {
  isServersAnswer,
  returnsHome,
  waitsForServer,
  waitsToOpenDownloads,
} from "./launch-offline";
import type { LaunchView } from "./launch-offline";
import type { Me } from "./me";
import type { SessionPhase } from "./session-phase";

const ME: Me = {
  userId: Brand.nominal<Me["userId"]>()("user-1"),
  username: "ada",
  displayName: null,
  role: "member",
  sessionId: Brand.nominal<Me["sessionId"]>()("session-1"),
  kind: "password",
  scopes: ["account"],
  device: null,
};

const launch: LaunchView = {
  heard: false,
  waiting: true,
  hasDownloads: true,
  onDownloadsList: false,
  offline: "no",
};

describe("hearing from the server", () => {
  const phases: ReadonlyArray<readonly [SessionPhase, boolean, boolean]> = [
    [{ kind: "loading" }, true, false],
    [{ kind: "ready", me: ME, saved: true }, true, false],
    [{ kind: "ready", me: ME, saved: false }, false, true],
    [{ kind: "signedOut", person: null }, false, true],
    [{ kind: "createOwner" }, false, true],
    [{ kind: "unavailable", cause: null, retry: () => undefined }, false, false],
  ];

  it.each(phases)("reads %o as waiting %s, answered %s", (phase, waiting, answered) => {
    expect([waitsForServer(phase), isServersAnswer(phase)]).toStrictEqual([waiting, answered]);
  });
});

describe("opening on the downloads", () => {
  it("waits while the server is silent at launch and the phone holds downloads", () => {
    expect(waitsToOpenDownloads(launch)).toBe(true);
  });

  it.each([
    ["the server answered this launch", { heard: true }],
    ["the server has said who is signed in", { waiting: false }],
    ["the phone holds no downloads", { hasDownloads: false }],
    ["the downloads already show", { offline: "silent" }],
    ["the person chose the downloads", { offline: "chosen" }],
  ] as const)("doesn't wait when %s", (_, change) => {
    expect(waitsToOpenDownloads({ ...launch, ...change })).toBe(false);
  });

  it("goes back Home once the server answers, from the list the silence opened", () => {
    const opened: LaunchView = { ...launch, offline: "silent", onDownloadsList: true };

    expect([returnsHome(opened), returnsHome({ ...opened, heard: true })]).toStrictEqual([
      false,
      true,
    ]);
  });

  it.each([
    ["a download or its player is open", { onDownloadsList: false }],
    ["the person chose the downloads", { offline: "chosen" }],
  ] as const)("stays on the downloads when %s", (_, change) => {
    expect(
      returnsHome({ ...launch, heard: true, offline: "silent", onDownloadsList: true, ...change }),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { sessionPhase, settle } from "./session-phase";
import type { PhaseInputs } from "./session-phase";

const signedIn: PhaseInputs = {
  connected: true,
  silent: false,
  hasDownloads: false,
  auth: "signedIn",
  ended: null,
  setup: { hasUsers: true, hasLibraries: true },
  role: "member",
  libraries: [{ lastScanAt: 1, scanning: false }],
  progress: "none",
};

describe("sessionPhase", () => {
  it("starts disconnected without a server", () => {
    expect(sessionPhase({ ...signedIn, connected: false }).kind).toBe("disconnected");
  });

  it("waits for the server, then calls a silent one unreachable", () => {
    expect(sessionPhase({ ...signedIn, setup: undefined }).kind).toBe("connecting");
    expect(sessionPhase({ ...signedIn, auth: "loading", silent: true }).kind).toBe("unreachable");
  });

  it("opens on the downloads when a silent server's account keeps some here", () => {
    const silent = { ...signedIn, hasDownloads: true, silent: true };

    expect(sessionPhase({ ...silent, auth: "loading" }).kind).toBe("offline");
    expect(sessionPhase({ ...silent, setup: undefined }).kind).toBe("offline");
    expect(sessionPhase({ ...silent, role: undefined }).kind).toBe("offline");
    expect(sessionPhase({ ...silent, silent: false, auth: "loading" }).kind).toBe("connecting");
  });

  it("follows what a server says once it answers, downloads or not", () => {
    const answered = { ...signedIn, hasDownloads: true, silent: true };

    expect(sessionPhase(answered).kind).toBe("ready");
    expect(sessionPhase({ ...answered, auth: "signedOut" }).kind).toBe("signedOut");
  });

  it("asks for the owner on a server without people, even with an old session", () => {
    expect(
      sessionPhase({ ...signedIn, setup: { hasUsers: false, hasLibraries: false } }).kind,
    ).toBe("needsOwner");
  });

  it("signs in on a server with people", () => {
    expect(sessionPhase({ ...signedIn, auth: "signedOut" }).kind).toBe("signedOut");
  });

  it("shows a suspended account as suspended, and any other ended session as signed out", () => {
    expect(sessionPhase({ ...signedIn, auth: "signedOut", ended: "suspended" }).kind).toBe(
      "suspended",
    );
    expect(sessionPhase({ ...signedIn, auth: "signedOut", ended: "removed" }).kind).toBe(
      "signedOut",
    );
  });

  it("asks an admin for a first library", () => {
    const empty = { ...signedIn, setup: { hasUsers: true, hasLibraries: false }, libraries: [] };

    expect(sessionPhase({ ...empty, role: "owner" }).kind).toBe("needsLibrary");
    expect(sessionPhase({ ...empty, role: "member" }).kind).toBe("ready");
  });

  it("follows the first scan, but not a later rescan", () => {
    expect(
      sessionPhase({ ...signedIn, libraries: [{ lastScanAt: null, scanning: true }] }).kind,
    ).toBe("scanning");
    expect(sessionPhase({ ...signedIn, libraries: [{ lastScanAt: 5, scanning: true }] }).kind).toBe(
      "ready",
    );
  });

  it("stays on Create account while the owner's sign-up finishes", () => {
    const created = { ...signedIn, setup: { hasUsers: true, hasLibraries: false }, libraries: [] };
    const creating = { ...created, progress: "creatingOwner" } as const;

    expect(sessionPhase({ ...creating, auth: "signedOut" }).kind).toBe("needsOwner");
    expect(sessionPhase({ ...creating, auth: "loading" }).kind).toBe("connecting");
    expect(sessionPhase({ ...creating, role: "owner" }).kind).toBe("needsLibrary");
    expect(sessionPhase({ ...created, auth: "signedOut" }).kind).toBe("signedOut");
  });

  it("keeps the first scan on screen after it ends, until the person leaves it", () => {
    const scanned = {
      ...signedIn,
      role: "owner" as const,
      libraries: [{ lastScanAt: 9, scanning: false }],
    };

    const scanning = { ...scanned, libraries: [{ lastScanAt: null, scanning: true }] } as const;

    expect(sessionPhase({ ...scanned, progress: "followingScan" }).kind).toBe("scanning");
    expect(sessionPhase({ ...scanning, progress: "leftScan" }).kind).toBe("ready");
    expect(sessionPhase({ ...scanned, progress: "none" }).kind).toBe("ready");
  });

  it("asks for a folder before following a scan that has no library yet", () => {
    const empty = { ...signedIn, setup: { hasUsers: true, hasLibraries: false }, libraries: [] };

    expect(sessionPhase({ ...empty, role: "owner", progress: "followingScan" }).kind).toBe(
      "needsLibrary",
    );
  });

  it("waits for the account and libraries once signed in", () => {
    expect(sessionPhase({ ...signedIn, role: undefined }).kind).toBe("connecting");
  });
});

describe("settle", () => {
  it("keeps the screens on show while the server is heard from again", () => {
    expect(settle({ kind: "connecting" }, { kind: "ready" })).toEqual({ kind: "ready" });
    expect(settle({ kind: "unreachable" }, { kind: "ready" })).toEqual({ kind: "ready" });
  });

  it("shows a server that never answered as unreachable", () => {
    expect(settle({ kind: "unreachable" }, null)).toEqual({ kind: "unreachable" });
    expect(settle({ kind: "connecting" }, null)).toBeNull();
  });

  it("moves to a new phase at once", () => {
    expect(settle({ kind: "signedOut" }, { kind: "ready" })).toEqual({ kind: "signedOut" });
  });

  it("opens offline only on a server that never answered this launch", () => {
    expect(settle({ kind: "offline" }, null)).toEqual({ kind: "offline" });
    expect(settle({ kind: "offline" }, { kind: "unreachable" })).toEqual({ kind: "offline" });
    expect(settle({ kind: "offline" }, { kind: "ready" })).toEqual({ kind: "ready" });
    expect(settle({ kind: "offline" }, { kind: "signedOut" })).toEqual({ kind: "signedOut" });
  });

  it("keeps the downloads on show when the last one goes, rather than closing them for G05", () => {
    expect(settle({ kind: "unreachable" }, { kind: "offline" })).toEqual({ kind: "offline" });
  });

  it("keeps the downloads on show while the server is heard from, then leaves for its phase", () => {
    expect(settle({ kind: "connecting" }, { kind: "offline" })).toEqual({ kind: "offline" });
    expect(settle({ kind: "ready" }, { kind: "offline" })).toEqual({ kind: "ready" });
    expect(settle({ kind: "signedOut" }, { kind: "offline" })).toEqual({ kind: "signedOut" });
  });
});

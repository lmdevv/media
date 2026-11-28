import { Unauthenticated } from "@media/contracts/errors";
import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import type { Me } from "./models";
import { sameScreens, sessionPhase, settle } from "./session-phase";
import type { PhaseInputs, SettledPhase } from "./session-phase";

const asUserId = Brand.nominal<Me["userId"]>();

const asSessionId = Brand.nominal<Me["sessionId"]>();

const aiko: Me = {
  userId: asUserId("aiko"),
  username: "aiko",
  displayName: null,
  role: "member",
  sessionId: asSessionId("s1"),
  kind: "grant",
  scopes: ["account", "music:read", "music:play", "music:edit"],
  device: null,
};

const signedIn: PhaseInputs = {
  connected: true,
  silent: false,
  hasDownloads: false,
  auth: "signedIn",
  launch: "done",
  signingIn: false,
  hasOwner: true,
  me: aiko,
  saved: false,
  refused: false,
  person: { userId: aiko.userId, username: "aiko" },
  progress: "none",
};

describe("sessionPhase", () => {
  it("starts disconnected without a server", () => {
    expect(sessionPhase({ ...signedIn, connected: false }).kind).toBe("disconnected");
  });

  it("waits for the server, then calls a silent one unreachable", () => {
    expect(sessionPhase({ ...signedIn, hasOwner: undefined }).kind).toBe("connecting");
    expect(sessionPhase({ ...signedIn, auth: "loading", silent: true }).kind).toBe("unreachable");
  });

  it("opens on the downloads when a silent server's person keeps some here", () => {
    const silent = { ...signedIn, hasDownloads: true, silent: true };

    expect(sessionPhase({ ...silent, auth: "loading" }).kind).toBe("offline");
    expect(sessionPhase({ ...silent, hasOwner: undefined }).kind).toBe("offline");
    expect(sessionPhase({ ...silent, me: undefined }).kind).toBe("offline");
    expect(sessionPhase({ ...silent, silent: false, auth: "loading" }).kind).toBe("connecting");
  });

  it("follows what a server says once it answers, downloads or not", () => {
    const answered = { ...signedIn, hasDownloads: true, silent: true };

    expect(sessionPhase(answered).kind).toBe("ready");
    expect(sessionPhase({ ...answered, auth: "signedOut" }).kind).toBe("signedOut");
  });

  it("asks for the owner on a server without one, even with an old session", () => {
    expect(sessionPhase({ ...signedIn, hasOwner: false }).kind).toBe("needsOwner");
  });

  it("waits for the launch's silent sign-in before it shows Sign in (D48)", () => {
    const signedOut = { ...signedIn, auth: "signedOut" as const, me: undefined };

    expect(sessionPhase({ ...signedOut, launch: "pending" }).kind).toBe("connecting");
    expect(sessionPhase({ ...signedOut, launch: "failed" }).kind).toBe("unreachable");
  });

  it("names the person this app last signed in as on Sign in (D59)", () => {
    expect(sessionPhase({ ...signedIn, auth: "signedOut", me: undefined })).toEqual({
      kind: "signedOut",
      person: { userId: aiko.userId, username: "aiko" },
    });
  });

  it("waits while a sign-in issues the grant and enrolls", () => {
    expect(sessionPhase({ ...signedIn, signingIn: true }).kind).toBe("connecting");
  });

  it("waits while the SDK settles a refused session, and calls any other failure unreachable", () => {
    const refused = new Unauthenticated({ message: "Session ended" });

    expect(sessionPhase({ ...signedIn, me: refused, refused: true }).kind).toBe("connecting");
    expect(sessionPhase({ ...signedIn, me: new Error("socket closed") }).kind).toBe("unreachable");
  });

  it("stays on Create account while the owner's sign-up finishes", () => {
    expect(
      sessionPhase({ ...signedIn, auth: "signedOut", me: undefined, progress: "creatingOwner" })
        .kind,
    ).toBe("needsOwner");
    expect(sessionPhase({ ...signedIn, progress: "creatingOwner" }).kind).toBe("ready");
  });

  it("asks the owner made here for a first library, then follows its first scan", () => {
    expect(sessionPhase({ ...signedIn, progress: "addingLibrary" }).kind).toBe("needsLibrary");
    expect(
      sessionPhase({ ...signedIn, progress: { kind: "followingScan", libraryId: "music" } }).kind,
    ).toBe("scanning");
  });

  it("shows Home from saved answers until the server's silence runs out", () => {
    const saved = { ...signedIn, saved: true };

    expect(sessionPhase(saved)).toEqual({ kind: "ready", me: aiko, saved: true });
    expect(sessionPhase({ ...saved, silent: true }).kind).toBe("unreachable");
    expect(sessionPhase({ ...saved, silent: true, hasDownloads: true }).kind).toBe("offline");
  });

  it("lets a sign-out win over saved answers", () => {
    expect(sessionPhase({ ...signedIn, saved: true, auth: "signedOut", me: undefined }).kind).toBe(
      "signedOut",
    );
  });
});

const ready: SettledPhase = { kind: "ready", me: aiko, saved: false };

const savedReady: SettledPhase = { kind: "ready", me: aiko, saved: true };

describe("settle", () => {
  it("keeps the screens on show while the server is heard from again", () => {
    expect(settle({ kind: "connecting" }, ready)).toBe(ready);
    expect(settle({ kind: "unreachable" }, ready)).toBe(ready);
  });

  it("shows a server that never answered as unreachable", () => {
    expect(settle({ kind: "unreachable" }, null)).toEqual({ kind: "unreachable" });
  });

  it("moves to a new phase at once", () => {
    const signedOut: SettledPhase = { kind: "signedOut", person: null };

    expect(settle(signedOut, ready)).toBe(signedOut);
  });

  it("opens offline only on a server that never answered this launch", () => {
    expect(settle({ kind: "offline" }, null)).toEqual({ kind: "offline" });
    expect(settle({ kind: "offline" }, ready)).toBe(ready);
  });

  it("keeps the downloads on show when the last one goes, rather than closing them for G05", () => {
    const offline: SettledPhase = { kind: "offline" };

    expect(settle({ kind: "unreachable" }, offline)).toBe(offline);
  });

  it("leaves a saved Home for the downloads or G05 when the server never answers", () => {
    expect(settle({ kind: "offline" }, savedReady)).toEqual({ kind: "offline" });
    expect(settle({ kind: "unreachable" }, savedReady)).toEqual({ kind: "unreachable" });
    expect(settle({ kind: "connecting" }, savedReady)).toBe(savedReady);
  });

  it("keeps the downloads on show while the server is heard from, then leaves for its phase", () => {
    const offline: SettledPhase = { kind: "offline" };

    expect(settle({ kind: "connecting" }, offline)).toBe(offline);
    expect(settle(ready, offline)).toBe(ready);
  });
});

describe("sameScreens", () => {
  it("is the same kind for the same person", () => {
    expect(
      sameScreens({ kind: "ready", me: { ...aiko, displayName: "Aiko" }, saved: false }, ready),
    ).toBe(true);
    expect(
      sameScreens(
        { kind: "ready", me: { ...aiko, userId: asUserId("mateo") }, saved: false },
        ready,
      ),
    ).toBe(false);
    expect(sameScreens({ kind: "offline" }, ready)).toBe(false);
    expect(sameScreens({ kind: "offline" }, null)).toBe(false);
  });

  it("takes the server's answer in place of a saved one, so its silence later keeps Home", () => {
    expect(sameScreens(ready, savedReady)).toBe(false);
    expect(settle({ kind: "unreachable" }, ready)).toBe(ready);
  });
});

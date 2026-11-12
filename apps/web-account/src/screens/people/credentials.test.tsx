import { Brand } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { disabledButton, loaded, noop, textOf } from "@/components/admin/testing";

import {
  ApiKeysView,
  DevicesView,
  keyFacts,
  keyPrefix,
  lastUsedLabel,
  scopeLabels,
  sessionFacts,
  sessionName,
  signOutNote,
} from "./credentials";
import type { KeyRow, SessionRow } from "./credentials";

const sessionId = Brand.nominal<SessionRow["sessionId"]>();

const deviceId = Brand.nominal<NonNullable<SessionRow["device"]>["deviceId"]>();

const keyId = Brand.nominal<KeyRow["keyId"]>();

const NOV_6 = Date.UTC(2026, 10, 6, 21, 30);

const session = (fields: Partial<SessionRow> = {}): SessionRow => ({
  sessionId: sessionId("s1"),
  kind: "password",
  name: null,
  device: null,
  scopes: ["account", "movies:read"],
  signedInAt: NOV_6,
  expiresAt: NOV_6 + 30 * 86_400_000,
  current: false,
  ...fields,
});

const key = (fields: Partial<KeyRow> = {}): KeyRow => ({
  keyId: keyId("jd7abcdefghijk"),
  name: "backup script",
  scopes: ["movies:play", "movies:read"],
  createdAt: NOV_6,
  expiresAt: null,
  lastUsedAt: null,
  ...fields,
});

describe("sessionName", () => {
  it("names a session by its device, else this browser or a password sign-in", () => {
    expect(sessionName(session({ name: "Firefox on Linux" }))).toBe("Firefox on Linux");
    expect(sessionName(session({ current: true }))).toBe("This browser");
    expect(sessionName(session())).toBe("Password sign-in");
  });
});

describe("DevicesView", () => {
  const rows = [
    session({ sessionId: sessionId("here"), name: "Firefox on Linux", current: true }),
    session({
      sessionId: sessionId("phone"),
      kind: "grant",
      name: "Aiko's iPhone",
      device: { deviceId: deviceId("d1"), name: "Aiko's iPhone" },
    }),
  ];

  it("lists each session with how it signed in, and Current for this one", () => {
    const text = textOf(
      <DevicesView
        sessions={loaded(rows)}
        ending={null}
        running={false}
        onAsk={noop}
        onEnd={noop}
      />,
    );

    expect(text).toContain("Firefox on Linux");
    expect(text).toContain("Current");
    expect(text).toContain("Aiko's iPhone");
    expect(text).toContain("App on a phone · Browse movies, Your account · Signed in");
    expect(text.match(/Sign out/gu)).toHaveLength(1);
  });

  it("asks before signing one out, and holds its buttons while that runs", () => {
    const asking = (
      <DevicesView
        sessions={loaded(rows)}
        ending={sessionId("phone")}
        running
        onAsk={noop}
        onEnd={noop}
      />
    );

    expect(textOf(asking)).toContain("It has to sign in again to keep watching.");
    expect(disabledButton(asking, "Sign out")).toBe(true);
  });
});

describe("an API key's sign-in on Devices", () => {
  const keyed = session({ kind: "apiKey", name: "Home Assistant", scopes: ["movies:play"] });

  it("is named by its key, says it is an API key and what it holds", () => {
    expect(sessionName(keyed)).toBe("Home Assistant");
    expect(sessionFacts(keyed)).toMatch(/^API key · Play movies · Signed in /u);
  });

  it("warns that the key signs in again, as old movies did", () => {
    expect(signOutNote(keyed)).toBe(
      "The key signs in again the next time it is used. Revoke the key to stop it.",
    );
    expect(signOutNote(session())).toBe("It has to sign in again to keep watching.");
  });
});

describe("API key facts", () => {
  it("shows the key's start, its scopes in order, and never its secret", () => {
    expect(keyPrefix(key())).toBe("mk_jd7abcde…");
    expect(scopeLabels(["movies:play", "movies:read"])).toBe("Browse movies, Play movies");
    expect(scopeLabels([])).toBe("No scopes");
  });

  it("says Never used, when it was last used, or Expired", () => {
    const now = NOV_6 + 86_400_000;

    expect(lastUsedLabel(key(), now)).toBe("Never used");
    expect(lastUsedLabel(key({ lastUsedAt: NOV_6 }), now)).toMatch(/^Last used /u);
    expect(lastUsedLabel(key({ expiresAt: now - 1, lastUsedAt: NOV_6 }), now)).toBe("Expired");
    expect(keyFacts(key(), now)).toMatch(
      /^Never used · Browse movies, Play movies · Created .* · mk_jd7abcde…$/u,
    );
  });
});

const keysView = (overrides: Partial<Parameters<typeof ApiKeysView>[0]> = {}) => (
  <ApiKeysView
    keys={loaded([key()])}
    grantable={["account", "movies:read", "movies:play"]}
    now={NOV_6}
    creating={false}
    created={null}
    revoking={null}
    running={null}
    onCreating={noop}
    onCreate={noop}
    onDone={noop}
    onAskRevoke={noop}
    onRevoke={noop}
    {...overrides}
  />
);

describe("ApiKeysView", () => {
  it("lists the keys with Revoke and offers Create key", () => {
    const text = textOf(keysView());

    expect(text).toContain("backup script");
    expect(text).toContain("Revoke");
    expect(text).toContain("Create key");
  });

  it("says when there are none", () => {
    expect(textOf(keysView({ keys: loaded([]) }))).toContain("No API keys.");
  });

  it("starts a new key with browse and play, and refuses one with no scope", () => {
    const creating = keysView({ creating: true });

    expect(renderToStaticMarkup(creating).match(/aria-checked="true"/gu)).toHaveLength(2);
    expect(disabledButton(creating, "Create key")).toBe(true);
  });

  it("offers only the scopes this session holds when creating one", () => {
    const text = textOf(keysView({ creating: true }));

    expect(text).toContain("Browse movies");
    expect(text).toContain("Your account");
    expect(text).not.toContain("Admin");
    expect(text).not.toContain("Edit movies");
  });

  it("shows a new key's secret once, and asks before revoking", () => {
    const created = { keyId: keyId("k2"), key: "mk_k2.secret", expiresAt: null };

    expect(textOf(keysView({ created }))).toContain("It never expires. It shows only this once.");
    expect(textOf(keysView({ revoking: key().keyId }))).toContain(
      "Anything using backup script stops working and is signed out.",
    );
  });
});

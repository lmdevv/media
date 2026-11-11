import { describe, expect, it } from "vitest";

import { canonicalJson, loadPassKeys, PASS_LIFETIME_MS, SERVER_ADDRESS } from "./sign-in";
import type { PassKeys } from "./sign-in";

const key = (fill: number): string => Buffer.alloc(32, fill).toString("base64url");

const keysOf = async (ring: string): Promise<PassKeys> => {
  const loaded = await loadPassKeys(ring);

  if (!loaded.ok) throw new Error(loaded.error.problem);

  return loaded.value;
};

const NOW = 1_800_000_000_000;

const params = { username: "ana", password: `secret-${crypto.randomUUID()}` };

describe("sign-in passes", () => {
  it("writes the same JSON for the same params in any key order", () => {
    expect(canonicalJson({ b: [1, { d: true, c: null }], a: "x" })).toBe(
      canonicalJson({ a: "x", b: [1, { c: null, d: true }] }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("checks a pass for exactly its sign-in, while it lasts, with any key of the ring", async () => {
    const signer = await keysOf(`k1:${key(1)}`);
    const verifier = await keysOf(`k2:${key(2)},k1:${key(1)}`);

    const pass = await signer.sign({
      provider: "password",
      params,
      address: "203.0.113.9",
      now: NOW,
    });

    const checked = await verifier.verify(pass, "password", params, NOW + 1000);

    expect(checked.ok && checked.value).toMatchObject({ expiresAt: NOW + PASS_LIFETIME_MS });

    const refusals = await Promise.all([
      verifier.verify(pass, "setup", params, NOW),
      verifier.verify(
        pass,
        "password",
        { ...params, password: `secret-${crypto.randomUUID()}` },
        NOW,
      ),
      verifier.verify(pass, "password", params, NOW + PASS_LIFETIME_MS),
      verifier.verify(pass, "password", params, NOW - 60_000),
      verifier.verify(`${pass.slice(0, -2)}AA`, "password", params, NOW),
      verifier.verify("p1.k1.1.nonce", "password", params, NOW),
      (await keysOf(`k3:${key(3)}`)).verify(pass, "password", params, NOW),
    ]);

    expect(refusals.map((refusal) => (refusal.ok ? "ok" : refusal.error.reason))).toEqual([
      "bad_signature",
      "bad_signature",
      "expired",
      "expired",
      "bad_signature",
      "malformed",
      "unknown_key",
    ]);
  });

  it("names a fresh nonce in every pass and never puts a key in one", async () => {
    const keys = await keysOf(`k1:${key(9)}`);

    const sign = () =>
      keys.sign({ provider: "apiKey", params: {}, address: SERVER_ADDRESS, now: NOW });

    const [first, second] = await Promise.all([sign(), sign()]);

    expect(first).not.toBe(second);
    expect(first).not.toContain(key(9));
  });

  it("names any address by a digest of fixed size, never the address itself", async () => {
    const keys = await keysOf(`k1:${key(4)}`);

    const passes = await Promise.all(
      ["", "203.0.113.9", "x".repeat(500), "東京の家"].map((address) =>
        keys.sign({ provider: "password", params, address, now: NOW }),
      ),
    );

    const checked = await Promise.all(
      passes.map((pass) => keys.verify(pass, "password", params, NOW)),
    );

    expect(checked.map((answer) => answer.ok)).toEqual([true, true, true, true]);
    expect(passes.every((pass) => !pass.includes("203.0.113.9") && pass.length < 140)).toBe(true);
  });
});

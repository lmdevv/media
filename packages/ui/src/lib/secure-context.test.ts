import { afterEach, describe, expect, it } from "vitest";

import { randomUuid } from "./secure-context";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const original = Object.getOwnPropertyDescriptor(Crypto.prototype, "randomUUID");

describe("randomUuid", () => {
  afterEach(() => {
    if (original !== undefined) {
      Object.defineProperty(Crypto.prototype, "randomUUID", original);
    }
  });

  it("makes RFC 4122 version 4 UUIDs", () => {
    for (let index = 0; index < 1000; index += 1) expect(randomUuid()).toMatch(UUID_V4);
  });

  it("does not repeat", () => {
    const made = new Set(Array.from({ length: 1000 }, () => randomUuid()));

    expect(made.size).toBe(1000);
  });

  it("works where crypto.randomUUID is missing, as on plain HTTP", () => {
    // Browsers only define randomUUID in secure contexts; remove it the same way.
    Reflect.deleteProperty(Crypto.prototype, "randomUUID");

    expect("randomUUID" in crypto).toBe(false);
    expect(randomUuid()).toMatch(UUID_V4);
  });
});

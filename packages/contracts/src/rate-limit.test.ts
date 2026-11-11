import { readFileSync } from "node:fs";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { addressBudgets, admit, canonicalAddress, doors } from "./rate-limit";
import type { AddressBucket, Door } from "./rate-limit";

const replay = (door: Door, times: ReadonlyArray<number>): ReadonlyArray<boolean> => {
  let bucket: AddressBucket | undefined;

  return times.map((now) => {
    const admission = admit(door, bucket, now);

    bucket = admission.bucket;

    return admission.admitted;
  });
};

const admittedCount = (answers: ReadonlyArray<boolean>): number =>
  answers.filter((admitted) => admitted).length;

describe("per-address rate limits", () => {
  it("rate-limits 100 guest-link sign-ins in one second from one address", () => {
    const times = Array.from({ length: 100 }, (_, index) => index * 10);
    const answers = replay("signIn", times);

    expect(admittedCount(answers)).toBe(addressBudgets.signIn.burst);
    expect(answers.slice(0, addressBudgets.signIn.burst).every((admitted) => admitted)).toBe(true);

    let bucket: AddressBucket | undefined;

    for (const now of times) bucket = admit("signIn", bucket, now).bucket;

    const refused = admit("signIn", bucket, 1000);

    expect(refused.admitted).toBe(false);
    expect(refused.admitted ? 0 : refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("admits one more request once the wait it named has passed", () => {
    let bucket: AddressBucket | undefined;

    for (let index = 0; index < addressBudgets.signIn.burst; index += 1) {
      bucket = admit("signIn", bucket, 0).bucket;
    }

    const refused = admit("signIn", bucket, 0);

    expect(refused.admitted).toBe(false);

    const wait = refused.admitted ? 0 : refused.retryAfterSeconds;

    expect(admit("signIn", refused.bucket, wait * 1000 - 1).admitted).toBe(false);
    expect(admit("signIn", refused.bucket, wait * 1000).admitted).toBe(true);
  });

  it("never saves up more than a burst, however long an address stays quiet", () => {
    const idle = 30 * 24 * 60 * 60 * 1000;
    const times = [0, ...Array.from({ length: 200 }, () => idle)];

    expect(admittedCount(replay("public", times))).toBe(addressBudgets.public.burst + 1);
  });

  it("mints nothing when the clock steps back", () => {
    let bucket: AddressBucket | undefined;

    for (let index = 0; index < addressBudgets.signIn.burst; index += 1) {
      bucket = admit("signIn", bucket, 60_000).bucket;
    }

    expect(admit("signIn", bucket, 0).admitted).toBe(false);
    expect(admit("signIn", bucket, 60_000).admitted).toBe(false);
  });

  it("admits at most a burst plus what refilled in any window", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...doors),
        fc.array(fc.integer({ min: 0, max: 120_000 }), { minLength: 1, maxLength: 300 }),
        (door, unsorted) => {
          const times = unsorted.toSorted((left, right) => left - right);
          const answers = replay(door, times);
          const { burst, perSecond } = addressBudgets[door];

          for (let from = 0; from < times.length; from += 1) {
            for (let to = from; to < times.length; to += 1) {
              const admitted = admittedCount(answers.slice(from, to + 1));
              const elapsed = ((times[to] ?? 0) - (times[from] ?? 0)) / 1000;

              if (admitted > burst + elapsed * perSecond + 1e-9) return false;
            }
          }

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("loads nothing, so the server and any other host can import it as it is", () => {
    const source = readFileSync(new URL("rate-limit.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/^\s*import[\s{*]/mu);
    expect(source).not.toMatch(/\bimport\s*\(/u);
    expect(source).not.toMatch(/\brequire\s*\(/u);
    expect(source).not.toMatch(/^\s*export\s[^\n]*\sfrom\s/mu);
  });
});

describe("canonical client addresses", () => {
  it.each([
    ["203.0.113.9", "203.0.113.9"],
    [" 203.0.113.9 ", "203.0.113.9"],
    ["::ffff:203.0.113.9", "203.0.113.9"],
    ["::FFFF:203.0.113.9", "203.0.113.9"],
    ["::ffff:cb00:7109", "203.0.113.9"],
    ["0:0:0:0:0:ffff:cb00:7109", "203.0.113.9"],
    ["[::ffff:203.0.113.9]", "203.0.113.9"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:db8::0001", "2001:db8::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["fe80::1%eth0", "fe80::1"],
    ["[fe80::1%25eth0]", "fe80::1"],
    ["0:0:0:0:0:0:0:1", "::1"],
    ["::", "::"],
    ["unknown", "unknown"],
    ["server", "server"],
    ["2001:db8::1::2", "2001:db8::1::2"],
    ["203.0.113.256", "203.0.113.256"],
  ])("writes %j as %j", (written, canonical) => {
    expect(canonicalAddress(written)).toBe(canonical);
  });

  it("gives every written form of one address the same form", () => {
    fc.assert(
      fc.property(fc.ipV4(), (address) => {
        expect(canonicalAddress(`::ffff:${address}`)).toBe(canonicalAddress(address));
      }),
    );
    fc.assert(
      fc.property(fc.ipV6(), (address) => {
        const canonical = canonicalAddress(address);

        expect(canonicalAddress(address.toUpperCase())).toBe(canonical);
        expect(canonicalAddress(`[${address}%eth0]`)).toBe(canonical);
        expect(canonicalAddress(canonical)).toBe(canonical);
      }),
    );
  });
});

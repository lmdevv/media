import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { limitRequest, makeLimiter } from "./rate-limit.ts";

const budget = { burst: 3, perSecond: 2 };

const proxy = Option.some("127.0.0.1");

const artwork = (peer: Option.Option<string>, forwardedFor?: string) => ({
  pathname: "/artwork/poster.jpg",
  peer,
  forwardedFor,
});

const health = (peer: Option.Option<string>, forwardedFor?: string) => ({
  pathname: "/api/health",
  peer,
  forwardedFor,
});

const refusedOf = (results: ReadonlyArray<Option.Option<number>>) =>
  results.filter(Option.isSome).length;

describe("rate limit", () => {
  it("allows a burst, refuses beyond it, and refills over time", () => {
    const take = makeLimiter();

    assert.deepStrictEqual(
      [0, 0, 0].map((now) => Option.isNone(take([["a", budget]], now))),
      [true, true, true],
    );
    assert.deepStrictEqual(take([["a", budget]], 0), Option.some(1));

    assert.isTrue(Option.isNone(take([["b", budget]], 0)));

    assert.isTrue(Option.isNone(take([["a", budget]], 500)));
    assert.isTrue(Option.isSome(take([["a", budget]], 500)));

    const after = [60_000, 60_000, 60_000, 60_000].map((now) =>
      Option.isNone(take([["a", budget]], now)),
    );

    assert.deepStrictEqual(after, [true, true, true, false]);
  });

  it("forgets the least recently used address when full, never a busy one", () => {
    const take = makeLimiter(3);

    for (let index = 0; index < 3; index += 1) take([["busy", budget]], 0);

    for (let index = 0; index < 100; index += 1) {
      take([[`new-${index}`, budget]], 0);
      assert.isTrue(Option.isSome(take([["busy", budget]], 0)));
    }
  });

  it("takes from every bucket or from none", () => {
    const take = makeLimiter();
    const roomy = { burst: 10, perSecond: 1 };

    for (let index = 0; index < 3; index += 1) take([["account", budget]], 0);

    assert.isTrue(
      Option.isSome(
        take(
          [
            ["session", roomy],
            ["account", budget],
          ],
          0,
          5,
        ),
      ),
    );
    assert.isTrue(Option.isNone(take([["session", roomy]], 0, 10)));
  });

  describe("behind the proxy", () => {
    it("gives each client behind the proxy its own bucket", () => {
      const take = makeLimiter();

      const first = Array.from({ length: 700 }, () =>
        limitRequest(take, artwork(proxy, "192.168.1.20"), 0),
      );

      const second = limitRequest(take, artwork(proxy, "192.168.1.21"), 0);

      assert.strictEqual(refusedOf(first), 100);
      assert.isTrue(Option.isNone(second));
    });

    it("takes the address the proxy appended, not one the client sent", () => {
      const take = makeLimiter();

      const spoofing = Array.from({ length: 700 }, (_, index) =>
        limitRequest(take, artwork(proxy, `10.0.0.${index % 250}, 192.168.1.20`), 0),
      );

      assert.strictEqual(refusedOf(spoofing), 100);
    });

    it("ignores X-Forwarded-For from a peer that is not the proxy", () => {
      const take = makeLimiter();
      const remote = Option.some("192.168.1.30");

      const spoofing = Array.from({ length: 700 }, (_, index) =>
        limitRequest(take, artwork(remote, `10.0.0.${index % 250}`), 0),
      );

      assert.strictEqual(refusedOf(spoofing), 100);
      assert.isTrue(Option.isSome(limitRequest(take, artwork(remote, "127.0.0.1"), 0)));
    });

    it("limits an outer proxy on loopback, which Caddy names as 127.0.0.1", () => {
      const take = makeLimiter();

      const throughOuterProxy = Array.from({ length: 700 }, () =>
        limitRequest(take, artwork(proxy, "127.0.0.1"), 0),
      );

      assert.strictEqual(refusedOf(throughOuterProxy), 100);
    });

    it("never refuses the health check, which calls the service directly", () => {
      const take = makeLimiter();

      for (let index = 0; index < 100; index += 1) {
        limitRequest(take, health(proxy, "127.0.0.1"), 0);
      }

      const checks = [
        limitRequest(take, health(Option.some("::ffff:127.0.0.1")), 0),
        limitRequest(take, health(Option.some("::1")), 0),
        ...Array.from({ length: 200 }, () => limitRequest(take, health(proxy), 0)),
      ];

      assert.strictEqual(refusedOf(checks), 0);
      assert.isTrue(Option.isSome(limitRequest(take, health(proxy, "127.0.0.1"), 0)));
    });
  });
});

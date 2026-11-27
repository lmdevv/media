import { ProtocolError, TransportError } from "@media/sdk/effect";
import { Release } from "@media/contracts/release";
import { Option, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { describeFailure, describeUnreadable } from "./failure";
import { followServer, rereadAfter } from "./server-release";
import type { ServerFollow, ThisApp } from "./server-release";
import { closeServers, startServer } from "./testing/local-server";

const GENERIC = "Something went wrong. Try again.";

/** One answer from the server that this app can't read; each call is another answer. */
const unreadableAnswer = (): ProtocolError =>
  new ProtocolError({
    operation: "movies.titles.get",
    message: "Protocol error in movies.titles.get: the result does not match the contract",
    cause: null,
  });

const unreadable = unreadableAnswer();

const UPDATE_ON_IPHONE = "Update Lar on this iPhone. Its server runs a newer version.";

/** A health report that names `release`, or none for null, and a value this app doesn't know. */
const healthOf = (release: string | null): string =>
  JSON.stringify({
    status: "ok",
    release,
    activeStreams: 0,
    runsAwaitingExit: 0,
    hardwareAcceleration: "nvenc",
    backend: "connected",
  });

const iPhone = (version: string | undefined): ThisApp => ({ version, device: "iPhone" });

const following: Array<ServerFollow> = [];

/** Follows a server that reports `release`, as an app at `app` does, and reads it once. */
const follow = async (release: string | null, app: ThisApp): Promise<ServerFollow> => {
  const mediaUrl = await startServer({ "/api/health": healthOf(release) });
  const followed = followServer(mediaUrl, app);

  following.push(followed);
  await followed.refresh();

  return followed;
};

afterEach(() => {
  for (const followed of following.splice(0)) followed.stop();
  closeServers();
});

describe("the line for an answer the app can't read", () => {
  it("asks to update the app on this iPhone or iPad when its server runs a newer release", async () => {
    await follow("0.10.0", iPhone("0.9.0"));

    expect(describeFailure(unreadable)).toBe(UPDATE_ON_IPHONE);

    await follow("1.0.0", { version: "0.9.0", device: "iPad" });

    expect(describeUnreadable()).toBe("Update Lar on this iPad. Its server runs a newer version.");
  });

  it("compares pre-releases the way semver does", async () => {
    await follow("0.10.0-rc.1", iPhone("0.9.0"));
    expect(describeUnreadable()).toBe(UPDATE_ON_IPHONE);

    await follow("0.10.0", iPhone("0.10.0-rc.1"));
    expect(describeUnreadable()).toBe(UPDATE_ON_IPHONE);

    await follow("0.10.0-rc.10", iPhone("0.10.0-rc.2"));
    expect(describeUnreadable()).toBe(UPDATE_ON_IPHONE);

    await follow("0.10.0-rc.2", iPhone("0.10.0"));
    expect(describeUnreadable()).toBe(GENERIC);
  });

  it("stays generic when the releases match, which means a bug", async () => {
    await follow("0.9.0", iPhone("0.9.0"));

    expect(describeFailure(unreadable)).toBe(GENERIC);
  });

  it("stays generic for a server older than the app", async () => {
    await follow("0.8.2", iPhone("0.9.0"));

    expect(describeFailure(unreadable)).toBe(GENERIC);
  });

  it("stays generic while either release is unknown", async () => {
    await follow("0.10.0", iPhone(undefined));
    expect(describeFailure(unreadable)).toBe(GENERIC);

    await follow(null, iPhone("0.9.0"));
    expect(describeFailure(unreadable)).toBe(GENERIC);
  });

  it("stays generic when the app follows no server", () => {
    expect(describeFailure(unreadable)).toBe(GENERIC);
  });

  it("leaves every other failure's line alone", async () => {
    await follow("0.10.0", iPhone("0.9.0"));

    expect(
      describeFailure(
        new TransportError({ operation: "movies.titles.get", message: "offline", cause: null }),
      ),
    ).toBe("Can't reach the server. Check the connection and try again.");
  });
});

describe("followServer", () => {
  it("reads the server's release again on refresh, and keeps it while the server is away", async () => {
    let release = "0.9.0";
    let answering = true;

    const mediaUrl = await startServer({
      "/api/health": async () => (answering ? healthOf(release) : "<html>"),
    });

    const followed = followServer(mediaUrl, iPhone("0.9.0"));

    following.push(followed);
    await followed.refresh();
    expect(describeUnreadable()).toBe(GENERIC);

    release = "0.10.0";
    await followed.refresh();
    expect(describeUnreadable()).toBe(UPDATE_ON_IPHONE);

    answering = false;
    await followed.refresh();
    expect(describeUnreadable()).toBe(UPDATE_ON_IPHONE);
  });

  it("resolves each refresh with the health it read, answered or not", async () => {
    let answering = true;

    const mediaUrl = await startServer({
      "/api/health": async () => (answering ? healthOf("0.9.0") : "<html>"),
    });

    const followed = followServer(mediaUrl, iPhone("0.9.0"));

    following.push(followed);
    expect(Option.map(await followed.refresh(), (health) => health.release)).toEqual(
      Option.some(Option.some(Schema.decodeSync(Release)("0.9.0"))),
    );

    answering = false;
    expect(Option.isNone(await followed.refresh())).toBe(true);
  });

  it("reads the release again after an answer it can't read, once per answer", async () => {
    let release = "0.9.0";
    let asks = 0;

    const mediaUrl = await startServer({
      "/api/health": async () => {
        asks += 1;

        return healthOf(release);
      },
    });

    const followed = followServer(mediaUrl, iPhone("0.9.0"));

    following.push(followed);
    await followed.refresh();
    release = "0.10.0";

    const first = unreadableAnswer();

    for (const render of [1, 2, 3])
      expect([render, describeFailure(first)]).toEqual([render, GENERIC]);

    await vi.waitFor(() => expect(describeUnreadable()).toBe(UPDATE_ON_IPHONE));
    expect(asks).toBe(2);

    expect(describeFailure(unreadableAnswer())).toBe(UPDATE_ON_IPHONE);
    await vi.waitFor(() => expect(asks).toBe(3));
  });

  it("sends two reads at most for a burst of answers it can't read", async () => {
    let asks = 0;

    const mediaUrl = await startServer({
      "/api/health": async () => {
        asks += 1;

        return healthOf("0.10.0");
      },
    });

    const followed = followServer(mediaUrl, iPhone("0.9.0"));

    following.push(followed);

    for (let answer = 0; answer < 20; answer += 1) describeFailure(unreadableAnswer());

    await vi.waitFor(() => expect(describeUnreadable()).toBe(UPDATE_ON_IPHONE));
    await vi.waitFor(() => expect(asks).toBe(2));

    describeFailure(unreadableAnswer());
    await vi.waitFor(() => expect(asks).toBe(3));
  });

  it("gives an answer that arrives during a read one more read after it", async () => {
    const before = Promise.withResolvers<string>();
    let asks = 0;

    const mediaUrl = await startServer({
      "/api/health": async () => {
        asks += 1;

        return asks === 1 ? before.promise : healthOf("0.10.0");
      },
    });

    const followed = followServer(mediaUrl, iPhone("0.9.0"));

    following.push(followed);
    describeFailure(unreadableAnswer());
    await vi.waitFor(() => expect(asks).toBe(1));

    // The server is updated, and the first answer it sends can't be read.
    expect(describeFailure(unreadableAnswer())).toBe(GENERIC);
    before.resolve(healthOf("0.9.0"));

    await vi.waitFor(() => expect(describeUnreadable()).toBe(UPDATE_ON_IPHONE));
    expect(asks).toBe(2);
  });

  it("stays generic against a release a screen read itself, whatever the app last read", async () => {
    await follow("0.10.0", iPhone("0.9.0"));

    expect(describeUnreadable()).toBe(UPDATE_ON_IPHONE);

    for (const rolledBack of ["0.9.0", "0.8.0"]) {
      expect(describeUnreadable(Schema.decodeOption(Release)(rolledBack))).toBe(GENERIC);
    }
  });

  it("asks to update against a release a screen read itself, ahead of the one last read", async () => {
    await follow("0.9.0", iPhone("0.9.0"));

    expect(describeUnreadable()).toBe(GENERIC);
    expect(describeUnreadable(Schema.decodeOption(Release)("0.10.0"))).toBe(UPDATE_ON_IPHONE);
  });

  it("reads nothing after an unreadable answer while the app follows no server", async () => {
    let asks = 0;

    const mediaUrl = await startServer({
      "/api/health": async () => {
        asks += 1;

        return healthOf("0.10.0");
      },
    });

    followServer(mediaUrl, iPhone("0.9.0")).stop();
    rereadAfter(unreadableAnswer());

    expect([asks, describeUnreadable()]).toEqual([0, GENERIC]);
  });

  it("tells onReread of each read made again, from its start, and never of a refresh", async () => {
    const asked: Array<string> = [];
    const answering = { up: true };

    const mediaUrl = await startServer({
      "/api/health": async () => {
        asked.push("read");

        return answering.up ? healthOf("0.10.0") : "not a health report";
      },
    });

    const followed = followServer(mediaUrl, iPhone("0.9.0"), () => {
      asked.push("started");

      return (health) => {
        asked.push(Option.isSome(health) ? "answered" : "unanswered");
      };
    });

    following.push(followed);
    await followed.refresh();
    answering.up = false;
    rereadAfter(unreadableAnswer());
    await vi.waitFor(() => {
      expect(asked).toEqual(["read", "started", "read", "unanswered"]);
    });
  });

  it("drops an answer for a server the app has since left", async () => {
    const late = Promise.withResolvers<string>();
    const leftUrl = await startServer({ "/api/health": () => late.promise });
    const left = followServer(leftUrl, iPhone("0.9.0"));
    const asked = left.refresh();

    left.stop();
    await follow("0.9.0", iPhone("0.9.0"));
    late.resolve(healthOf("0.10.0"));
    await asked;

    expect(describeUnreadable()).toBe(GENERIC);
  });

  it("follows only the latest server, and lets an earlier follow's answers and stop pass", async () => {
    const earlierUrl = await startServer({ "/api/health": healthOf("0.10.0") });
    const earlier = followServer(earlierUrl, iPhone("0.9.0"));

    following.push(earlier);
    await follow("0.9.0", iPhone("0.9.0"));
    await earlier.refresh();
    expect(describeUnreadable()).toBe(GENERIC);

    const newer = await follow("0.11.0", iPhone("0.9.0"));

    earlier.stop();
    expect(describeUnreadable()).toBe(UPDATE_ON_IPHONE);
    newer.stop();
    expect(describeUnreadable()).toBe(GENERIC);
  });

  it("drops an answer a later refresh has overtaken", async () => {
    const arrived = Promise.withResolvers<void>();
    const late = Promise.withResolvers<string>();
    let asks = 0;

    const mediaUrl = await startServer({
      "/api/health": async () => {
        asks += 1;

        if (asks > 1) return healthOf("0.9.0");

        arrived.resolve();

        return late.promise;
      },
    });

    const followed = followServer(mediaUrl, iPhone("0.9.0"));

    following.push(followed);
    const slow = followed.refresh();

    await arrived.promise;
    await followed.refresh();
    late.resolve(healthOf("0.10.0"));
    await slow;

    expect(describeUnreadable()).toBe(GENERIC);
  });
});

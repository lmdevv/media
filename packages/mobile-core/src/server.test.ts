import { Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  connectManually,
  discoverServer,
  normalizeServerUrl,
  readHealth,
  reachableUrl,
} from "./server";
import { closeServers, startServer as start } from "./testing/local-server";

const report = {
  status: "ok",
  release: "0.9.0",
  activeStreams: 0,
  runsAwaitingExit: 0,
  hardwareAcceleration: "none",
  backend: "connected",
};

const health = JSON.stringify(report);

afterEach(closeServers);

describe("normalizeServerUrl", () => {
  it("adds https, keeps paths, and drops trailing slashes", () => {
    expect(normalizeServerUrl(" cinema.home/ ")).toBe("https://cinema.home");
    expect(normalizeServerUrl("http://nas.local:8080/movies/")).toBe(
      "http://nas.local:8080/movies",
    );
  });

  it("refuses text that is not an http address", () => {
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("ftp://cinema.home")).toBeNull();
    expect(normalizeServerUrl("http://")).toBeNull();
  });
});

describe("reachableUrl", () => {
  it("moves a loopback account server onto the media service's host", () => {
    expect(reachableUrl("http://localhost:3210", "http://192.168.1.20:8080")).toBe(
      "http://192.168.1.20:3210",
    );
    expect(reachableUrl("http://127.0.0.1:3210/api", "https://cinema.home")).toBe(
      "http://cinema.home:3210/api",
    );
    expect(reachableUrl("http://[::1]:3210", "http://[fd00::5]:8080")).toBe(
      "http://[fd00::5]:3210",
    );
  });

  it("keeps an account server that is not loopback, or a media service that is", () => {
    expect(reachableUrl("https://accounts.cinema.home", "https://cinema.home")).toBe(
      "https://accounts.cinema.home",
    );
    expect(reachableUrl("http://localhost:3210", "http://127.0.0.1:8080")).toBe(
      "http://localhost:3210",
    );
  });
});

describe("readHealth", () => {
  it("reads a server's release and its whole report", async () => {
    const mediaUrl = await start({ "/api/health": health });

    expect(await readHealth(mediaUrl)).toEqual(
      Option.some({ release: Option.some("0.9.0"), report: Option.some(report) }),
    );
  });

  it("keeps a newer server that names a value this app doesn't know, without its report", async () => {
    const mediaUrl = await start({
      "/api/health": JSON.stringify({
        ...report,
        release: "0.10.0",
        hardwareAcceleration: "nvenc",
      }),
    });

    expect(await readHealth(mediaUrl)).toEqual(
      Option.some({ release: Option.some("0.10.0"), report: Option.none() }),
    );
  });

  it("reads a pre-release", async () => {
    const mediaUrl = await start({
      "/api/health": JSON.stringify({ ...report, release: "0.10.0-rc.1" }),
    });

    expect(await readHealth(mediaUrl)).toEqual(
      Option.some({
        release: Option.some("0.10.0-rc.1"),
        report: Option.some({ ...report, release: "0.10.0-rc.1" }),
      }),
    );
  });

  it("reads past a field this app doesn't know", async () => {
    const mediaUrl = await start({
      "/api/health": JSON.stringify({ ...report, storage: { freeBytes: 1 } }),
    });

    expect(await readHealth(mediaUrl)).toEqual(
      Option.some({ release: Option.some("0.9.0"), report: Option.some(report) }),
    );
  });

  it("counts a server that names no release it can read as answering", async () => {
    const { release: _, ...unnamed } = report;
    const withoutRelease = await start({ "/api/health": JSON.stringify(unnamed) });

    const otherRelease = await start({
      "/api/health": JSON.stringify({ ...report, release: "nightly" }),
    });

    expect(await readHealth(withoutRelease)).toEqual(
      Option.some({ release: Option.none(), report: Option.none() }),
    );
    expect(await readHealth(otherRelease)).toEqual(
      Option.some({
        release: Option.none(),
        report: Option.some({ ...report, release: "nightly" }),
      }),
    );
  });

  it("finds no Lar server where the health check fails or says something else", async () => {
    const missing = await start({});
    const notOk = await start({ "/api/health": JSON.stringify({ ...report, status: "down" }) });
    const notJson = await start({ "/api/health": "<html>" });

    expect(await readHealth(missing)).toEqual(Option.none());
    expect(await readHealth(notOk)).toEqual(Option.none());
    expect(await readHealth(notJson)).toEqual(Option.none());
  });
});

describe("discoverServer", () => {
  it("finds the account server from the media address", async () => {
    const convexUrl = await start({ "/version": JSON.stringify("1.0") });

    const mediaUrl = await start({
      "/api/health": health,
      "/api/client-config": JSON.stringify({ convexUrl }),
    });

    expect(await discoverServer(`${mediaUrl}/`)).toEqual({
      ok: true,
      connection: { mediaUrl, convexUrl, moviesUrl: `${mediaUrl}/movies` },
    });
  });

  it("takes the movies web client's address from the server", async () => {
    const convexUrl = await start({ "/version": JSON.stringify("1.0") });

    const mediaUrl = await start({
      "/api/health": health,
      "/api/client-config": JSON.stringify({
        convexUrl,
        moviesUrl: "http://localhost:8080/movies/",
      }),
    });

    expect(await discoverServer(mediaUrl)).toEqual({
      ok: true,
      connection: { mediaUrl, convexUrl, moviesUrl: "http://localhost:8080/movies" },
    });
  });

  it("refuses an account server the phone cannot reach", async () => {
    const mediaUrl = await start({
      "/api/health": health,
      "/api/client-config": JSON.stringify({ convexUrl: "http://127.0.0.1:9" }),
    });

    expect(await discoverServer(mediaUrl)).toEqual({ ok: false, failure: "accountsUnreachable" });
  });

  it("asks for connection details when the server doesn't share its account server", async () => {
    const withoutUrl = await start({ "/api/health": health, "/api/client-config": "{}" });
    const olderServer = await start({ "/api/health": health });

    expect(await discoverServer(withoutUrl)).toEqual({ ok: false, failure: "needsDetails" });
    expect(await discoverServer(olderServer)).toEqual({ ok: false, failure: "needsDetails" });
  });

  it("connects to a newer server whose health names a value this app doesn't know", async () => {
    const convexUrl = await start({ "/version": JSON.stringify("1.0") });

    const mediaUrl = await start({
      "/api/health": JSON.stringify({
        ...report,
        hardwareAcceleration: "nvenc",
        storage: { freeBytes: 1 },
      }),
      "/api/client-config": JSON.stringify({ convexUrl }),
    });

    expect(await discoverServer(mediaUrl)).toEqual({
      ok: true,
      connection: { mediaUrl, convexUrl, moviesUrl: `${mediaUrl}/movies` },
    });
  });

  it("reports something that is not a media service as unreachable", async () => {
    const mediaUrl = await start({ "/api/health": JSON.stringify({ hello: "world" }) });

    expect(await discoverServer(mediaUrl)).toEqual({ ok: false, failure: "unreachable" });
  });

  it("falls back to http when an address without a scheme has no https", async () => {
    const convexUrl = await start({ "/version": JSON.stringify("1.0") });

    const mediaUrl = await start({
      "/api/health": health,
      "/api/client-config": JSON.stringify({ convexUrl }),
    });

    expect(await discoverServer(mediaUrl.replace("http://", ""))).toEqual({
      ok: true,
      connection: { mediaUrl, convexUrl, moviesUrl: `${mediaUrl}/movies` },
    });
  });
});

describe("connectManually", () => {
  it("connects when both servers answer", async () => {
    const mediaUrl = await start({ "/api/health": health });
    const convexUrl = await start({ "/version": JSON.stringify("1.0") });

    expect(await connectManually(mediaUrl, convexUrl)).toEqual({
      ok: true,
      connection: { mediaUrl, convexUrl, moviesUrl: `${mediaUrl}/movies` },
    });
  });

  it("refuses an account server that does not answer", async () => {
    const mediaUrl = await start({ "/api/health": health });

    expect(await connectManually(mediaUrl, "http://127.0.0.1:9")).toEqual({
      ok: false,
      failure: "accountsUnreachable",
    });
  });
});

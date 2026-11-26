import { ConvexHttpClient } from "convex/browser";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import { AWAY_MS } from "../../convex/core/serverStatus";
import { runFunction } from "../admin";
import { member } from "../devices";
import { runServer, runServerAs } from "../service";
import { refusal, unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";

const stack = coreStackFromEnvFile();

/** `length` characters of three bytes each in UTF-8: the most a text under a cap can weigh. */
const text = (length: number): string => "語".repeat(length);

describe.skipIf(stack === undefined)("server status", { timeout: 60_000 }, () => {
  it("show an admin what the media server reported last, and refuse a member", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "status-admin", "admin");
    const person = await member(stack, "status-member");
    const version = `0.0.0-${unique()}`;
    const startedAt = Date.now() - 60_000;

    const gpu = {
      node: "renderD128",
      opened: true,
      pci: "8086:56a5 rev 05",
      kernelDriver: "i915",
      userDriver: "Intel iHD driver for Intel(R) Gen Graphics 26.3.5",
      checkedAt: startedAt,
    };

    const unsupported = {
      key: "decode.qsv:h264/yuv420p10le",
      domain: "qsv",
      status: "unsupported" as const,
      source: "probe" as const,
      checkedAt: startedAt,
      reason: "refused" as const,
      quarantineEndsAt: null,
    };

    const transcoding = {
      build: { version: "9.0.2", kernel: "6.18.63", checkedAt: startedAt },
      devices: [
        { ...gpu, domain: "qsv" },
        { ...gpu, domain: "vaapi" },
      ],
      capabilities: [
        unsupported,
        {
          key: "encode.qsv:h264/8/cbr",
          domain: "qsv",
          status: "verified" as const,
          source: "probe" as const,
          checkedAt: startedAt,
          reason: "passed" as const,
          quarantineEndsAt: "restart" as const,
        },
        {
          key: "tonemap.cpu:pq",
          domain: "cpu",
          status: "verified" as const,
          source: "listing" as const,
          checkedAt: startedAt,
          reason: "listed" as const,
          quarantineEndsAt: startedAt + 900_000,
        },
      ],
    };

    const reported = { version, activeStreams: 2, runsAwaitingExit: 1, startedAt, transcoding };

    const before = Date.now();

    await runServer(stack, api.core.serverStatus.report, reported, Schema.Null);

    const status = await admin.signedIn.client.query(api.core.server.status, {});

    expect(status).toMatchObject(reported);
    expect(status?.reportedAt).toBeGreaterThanOrEqual(before - 5000);

    await runServer(
      stack,
      api.core.serverStatus.report,
      {
        ...reported,
        activeStreams: 0,
        transcoding: { build: null, devices: [], capabilities: [] },
      },
      Schema.Null,
    );
    expect(await admin.signedIn.client.query(api.core.server.status, {})).toMatchObject({
      version,
      activeStreams: 0,
      transcoding: { build: null, devices: [], capabilities: [] },
    });

    expect(await refusal(person.signedIn.client.query(api.core.server.status, {}))).toBe(
      "forbidden",
    );
    expect(
      await refusal(
        runServerAs(stack, person.signedIn, api.core.serverStatus.report, reported, Schema.Null),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(
        runServer(
          stack,
          api.core.serverStatus.report,
          { ...reported, activeStreams: -1 },
          Schema.Null,
        ),
      ),
    ).toBe("invalid_args");
    expect(
      await refusal(
        runServer(
          stack,
          api.core.serverStatus.report,
          { ...reported, version: "v".repeat(65) },
          Schema.Null,
        ),
      ),
    ).toBe("invalid_args");
    expect(
      await refusal(
        runServer(
          stack,
          api.core.serverStatus.report,
          {
            ...reported,
            transcoding: {
              ...transcoding,
              capabilities: Array.from({ length: 1001 }, (_, index) => ({
                ...unsupported,
                key: `decode.qsv:h264/${String(index)}`,
              })),
            },
          },
          Schema.Null,
        ),
      ),
    ).toBe("invalid_args");
  });

  it("tell anyone, signed in or not, once the media server goes silent and once it beats again", async () => {
    if (stack === undefined) return;
    const person = await member(stack, "presence-member");
    const anonymous = new ConvexHttpClient(stack.url, { logger: false });
    const presence = () => anonymous.query(api.core.server.presence, {});

    const sweepAsOf = (asOf: number) =>
      runFunction(stack, internal.core.serverStatus.sweep, { asOf }, Schema.Null);

    await runServer(stack, api.core.serverStatus.beat, {}, Schema.Null);
    expect(await presence()).toBe("present");
    expect(await person.signedIn.client.query(api.core.server.presence, {})).toBe("present");

    await sweepAsOf(Date.now() + AWAY_MS - 5000);
    expect(await presence()).toBe("present");

    await sweepAsOf(Date.now() + AWAY_MS + 5000);
    expect(await presence()).toBe("away");

    await runServer(stack, api.core.serverStatus.beat, {}, Schema.Null);
    expect(await presence()).toBe("present");

    expect(
      await refusal(
        runServerAs(stack, person.signedIn, api.core.serverStatus.beat, {}, Schema.Null),
      ),
    ).toBe("forbidden");
  });

  it("store the largest report the caps allow, and refuse a text one character past its cap", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "status-largest", "admin");
    const startedAt = Date.now() - 60_000;

    const device = {
      domain: text(64),
      node: text(64),
      opened: true,
      pci: text(64),
      kernelDriver: text(64),
      userDriver: text(128),
      checkedAt: startedAt,
    };

    const capability = {
      domain: text(64),
      status: "unsupported" as const,
      source: "probe" as const,
      checkedAt: startedAt,
      reason: "inconclusive" as const,
      quarantineEndsAt: startedAt + 900_000,
    };

    const transcoding = {
      build: { version: text(64), kernel: text(64), checkedAt: startedAt },
      devices: Array.from({ length: 16 }, () => device),
      capabilities: Array.from({ length: 1000 }, (_, index) => ({
        ...capability,
        key: `${String(index).padStart(4, "0")}${text(76)}`,
      })),
    };

    const largest = {
      version: `0.0.0-${unique()}`.padEnd(64, "0"),
      activeStreams: 0,
      runsAwaitingExit: 0,
      startedAt,
      transcoding,
    };

    await runServer(stack, api.core.serverStatus.report, largest, Schema.Null);

    const stored = await admin.signedIn.client.query(api.core.server.status, {});

    expect(stored?.version).toBe(largest.version);
    expect(stored?.transcoding).toStrictEqual(transcoding);

    const pastCaps = [
      { ...transcoding, build: { ...transcoding.build, kernel: text(65) } },
      { ...transcoding, devices: [{ ...device, userDriver: text(129) }] },
      { ...transcoding, devices: [{ ...device, pci: text(65) }] },
      { ...transcoding, capabilities: [{ ...capability, key: text(81) }] },
      { ...transcoding, capabilities: [{ ...capability, key: "k", domain: text(65) }] },
    ];

    const refusals = await Promise.all(
      pastCaps.map((past) =>
        refusal(
          runServer(
            stack,
            api.core.serverStatus.report,
            { ...largest, transcoding: past },
            Schema.Null,
          ),
        ),
      ),
    );

    expect(refusals).toStrictEqual(pastCaps.map(() => "invalid_args"));
  });
});

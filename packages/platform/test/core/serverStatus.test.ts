import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { member } from "../devices";
import { runServer, runServerAs } from "../service";
import { refusal, unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";

const stack = coreStackFromEnvFile();

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
      userDriver: "Intel iHD driver for Intel(R) Gen Graphics - 26.3.5",
      checkedAt: startedAt,
    };

    const unsupported = {
      key: "decode.qsv:h264/yuv420p10le",
      domain: "qsv",
      status: "unsupported" as const,
      source: "probe" as const,
      checkedAt: startedAt,
      detail: "rejected: Error querying IO surface",
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
          detail: "passed",
          quarantineEndsAt: "restart" as const,
        },
        {
          key: "tonemap.cpu:pq",
          domain: "cpu",
          status: "verified" as const,
          source: "listing" as const,
          checkedAt: startedAt,
          detail: "lists filter:zscale",
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
});

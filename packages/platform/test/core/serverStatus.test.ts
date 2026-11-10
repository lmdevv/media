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

    const reported = {
      version,
      hardwareAcceleration: "qsv" as const,
      activeStreams: 2,
      runsAwaitingExit: 1,
      startedAt: Date.now() - 60_000,
    };

    const before = Date.now();

    await runServer(stack, api.core.serverStatus.report, reported, Schema.Null);

    const status = await admin.signedIn.client.query(api.core.server.status, {});

    expect(status).toMatchObject(reported);
    expect(status?.reportedAt).toBeGreaterThanOrEqual(before - 5000);

    await runServer(
      stack,
      api.core.serverStatus.report,
      { ...reported, activeStreams: 0, hardwareAcceleration: "vaapi" },
      Schema.Null,
    );
    expect(await admin.signedIn.client.query(api.core.server.status, {})).toMatchObject({
      version,
      activeStreams: 0,
      hardwareAcceleration: "vaapi",
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
  });
});

import { CLIENT_ERROR_LIMITS } from "@media/contracts/diagnostics";
import { NotFound } from "@media/contracts/errors";
import { PlaybackSessionId } from "@media/contracts/ids";
import { describe, expect, it } from "vitest";

import { reportOf } from "./client-error-report";
import type { ErrorContext } from "./client-error-report";

const context: ErrorContext = {
  platform: "web",
  appVersion: "0.2.0",
  kind: "route",
  route: "/titles/title_1",
};

describe("reportOf", () => {
  it("keeps an error's name, message, and stack", () => {
    const error = new TypeError("Cannot read properties of undefined");

    expect(reportOf(error, context)).toStrictEqual({
      ...context,
      name: "TypeError",
      message: "Cannot read properties of undefined",
      stack: error.stack,
    });
  });

  it("cuts every text field to its bound", () => {
    const error = new Error("m".repeat(5000));

    error.name = "N".repeat(500);
    error.stack = "s".repeat(10_000);

    const cut = reportOf(error, {
      ...context,
      appVersion: "v".repeat(100),
      route: `/${"r".repeat(1000)}`,
    });

    expect(cut.name).toHaveLength(CLIENT_ERROR_LIMITS.name);
    expect(cut.message).toHaveLength(CLIENT_ERROR_LIMITS.message);
    expect(cut.stack).toHaveLength(CLIENT_ERROR_LIMITS.stack);
    expect(cut.appVersion).toHaveLength(CLIENT_ERROR_LIMITS.appVersion);
    expect(cut.route).toHaveLength(CLIENT_ERROR_LIMITS.route);
  });

  it("names an SDK error by its tag and keeps the request it failed", () => {
    const requestId = "0b6f4c2e-8d3a-4f6b-9c1d-2e3f4a5b6c7d";

    expect(reportOf(new NotFound({ message: "No such title", requestId }), context)).toMatchObject({
      name: "NotFound",
      message: "No such title",
      requestId,
    });
  });

  it("describes a thrown value that is not an error", () => {
    expect(reportOf("offline", { ...context, kind: "unhandled-rejection" })).toEqual({
      ...context,
      kind: "unhandled-rejection",
      name: "NonError",
      message: "offline",
    });
  });

  it("describes a plain object that was thrown as its JSON", () => {
    expect(
      reportOf({ reason: "offline", attempts: 3 }, { ...context, kind: "uncaught" }),
    ).toMatchObject({ name: "NonError", message: '{"reason":"offline","attempts":3}' });
  });

  it("cuts the JSON of a large thrown object to the message bound", () => {
    const cut = reportOf({ text: "x".repeat(5000) }, context);

    expect(cut.message).toHaveLength(CLIENT_ERROR_LIMITS.message);
  });

  it("names an error whose name is not text by the fallback", () => {
    const error = new Error("boom");

    Object.defineProperty(error, "name", { value: 42 });

    expect(reportOf(error, context)).toMatchObject({ name: "NonError" });
  });

  it("leaves out a playback session too long to be one", () => {
    const sessionId = PlaybackSessionId.make("s".repeat(CLIENT_ERROR_LIMITS.sessionId + 1));

    expect(reportOf(new Error("x"), { ...context, sessionId })).not.toHaveProperty("sessionId");
  });

  it("keeps the playback session the app names", () => {
    const sessionId = PlaybackSessionId.make("session_1");

    expect(reportOf(new Error("x"), { ...context, sessionId })).toMatchObject({
      sessionId,
    });
  });
});

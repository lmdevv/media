import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { Effect, Option, Predicate, Redacted, Schema, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PlaybackTokenInvalid,
  StreamGenerationGone,
  StreamNotFound,
  TranscodeCapacityReached,
} from "@media/contracts/media-playback";

import type { MediaRequest } from "./media-http";
import { requestJson, requestLines, requestPlayback } from "./media-http";
import { recoveryFor } from "./playback";

const received: Array<{
  readonly url: string;
  readonly auth: string | undefined;
  readonly body: string;
}> = [];

const respond = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
};

const FAILED_ID = "0b6f3c1e-5d2a-4e8f-9a7b-3c4d5e6f7a81";

const GARBLED_ID = "1c7a4d2f-6e3b-4f9a-8b8c-4d5e6f7a8b92";

const WRONG_ID = "2d8b5e3a-7f4c-4a1b-ac9d-5e6f7a8b9ca3";

const BUSY_ID = "3e9c6f4b-8a5d-4b2c-bdae-6f7a8b9cadb4";

const APPENDED_ID = "4fad7a5c-9b6e-4c3d-8ebf-7a8b9cadbec5";

const traced = (
  response: ServerResponse,
  status: number,
  body: string,
  requestId: string,
): void => {
  response.writeHead(status, { "content-type": "application/json", "x-request-id": requestId });
  response.end(body);
};

const route = (path: string, response: ServerResponse): void => {
  switch (path) {
    case "/traced/failure":
      return traced(
        response,
        403,
        JSON.stringify({ code: "forbidden", message: "Admins only" }),
        FAILED_ID,
      );
    case "/traced/garbage":
      return traced(response, 500, "<html>Internal error</html>", GARBLED_ID);
    case "/traced/wrong":
      return traced(response, 200, JSON.stringify({ ok: "yes" }), WRONG_ID);
    case "/traced/busy":
      return traced(
        response,
        503,
        JSON.stringify({ code: "rate_limited", message: "Busy" }),
        BUSY_ID,
      );
    case "/traced/appended":
      return traced(
        response,
        403,
        JSON.stringify({ code: "forbidden", message: "Admins only" }),
        `req-gw, ${APPENDED_ID}`,
      );
    case "/traced/gateway":
      return traced(response, 504, "<html>Gateway timeout</html>", "req-gw");
    case "/traced/foreign":
      return traced(
        response,
        403,
        JSON.stringify({ code: "forbidden", message: "Admins only" }),
        "req-123",
      );
    case "/traced/unsafe":
      return traced(
        response,
        403,
        JSON.stringify({ code: "forbidden", message: "Admins only" }),
        "req 1; rm -rf",
      );
    case "/ok":
      return respond(response, 200, JSON.stringify({ ok: true }));
    case "/failure":
      return respond(response, 403, JSON.stringify({ code: "forbidden", message: "Admins only" }));
    case "/limited":
      response.writeHead(429, { "content-type": "application/json", "retry-after": "42" });
      response.end(JSON.stringify({ code: "rate_limited", message: "Too many" }));

      return;
    case "/tagged":
      return respond(response, 422, JSON.stringify({ _tag: "UnsupportedPlayback", reason: "x" }));
    case "/gone":
      return respond(
        response,
        410,
        JSON.stringify({
          _tag: "StreamGenerationGone",
          streamId: "abc",
          generation: 1,
          currentGeneration: 2,
        }),
      );
    case "/expired":
      return respond(
        response,
        401,
        JSON.stringify({ _tag: "PlaybackTokenInvalid", reason: "expired", message: "expired" }),
      );
    case "/lines":
      response.writeHead(200, { "content-type": "application/x-ndjson", "x-test": "yes" });
      response.end('{"n":1}\n{"n":2}\n');

      return;
    case "/gateway":
      return respond(response, 502, "<html>Bad gateway</html>");
    case "/garbage":
      return respond(response, 200, "<html>");
    case "/wrong":
      return respond(response, 200, JSON.stringify({ ok: "yes" }));
    default:
      return respond(response, 404, "");
  }
};

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";

  request.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });

  request.on("end", () => {
    received.push({ url: request.url ?? "", auth: request.headers.authorization, body });
    route(request.url ?? "", response);
  });
});

let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || Predicate.isString(address)) throw new Error("The server is not on TCP");

  base = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(() => {
  server.close();
});

const Ok = Schema.Struct({ ok: Schema.Literal(true) });

const request = (path: string): MediaRequest => ({
  operation: "test.call",
  url: `${base}${path}`,
  method: "POST",
  body: Option.some({ hello: "world" }),
  bearer: Option.some(Redacted.make("secret-jwt")),
});

const outcome = (path: string) => Effect.runPromise(Effect.result(requestJson(request(path), Ok)));

describe("media service requests", () => {
  it("sends the JSON body and bearer token and decodes the answer", async () => {
    const result = await outcome("/ok");

    expect(result).toMatchObject({ _tag: "Success", success: { ok: true } });
    expect(received.at(-1)).toMatchObject({
      auth: "Bearer secret-jwt",
      body: JSON.stringify({ hello: "world" }),
    });
  });

  it("turns a { code, message } failure into its command error", async () => {
    expect(await outcome("/failure")).toMatchObject({
      failure: { _tag: "Forbidden", message: "Admins only" },
    });
  });

  it("says how long to wait when the service limits the caller", async () => {
    expect(await outcome("/limited")).toMatchObject({
      failure: { _tag: "RateLimited", message: "Too many", retryAfterSeconds: 42 },
    });
  });

  it("maps a tagged HttpApi failure by status and names the tag", async () => {
    const result = await outcome("/tagged");

    expect(result).toMatchObject({ failure: { _tag: "InvalidArgs" } });
    expect(JSON.stringify(result)).toContain("UnsupportedPlayback");
  });

  it("reports bodies outside the contract as protocol errors", async () => {
    expect(await outcome("/garbage")).toMatchObject({ failure: { _tag: "ProtocolError" } });
    expect(await outcome("/wrong")).toMatchObject({ failure: { _tag: "ProtocolError" } });
  });

  it("reports an unreachable service as a transport error", async () => {
    const result = await Effect.runPromise(
      Effect.result(requestJson({ ...request("/ok"), url: "http://127.0.0.1:9/ok" }, Ok)),
    );

    expect(result).toMatchObject({ failure: { _tag: "TransportError" } });
    expect(result).not.toHaveProperty("failure.requestId");
  });

  it("carries the media service's request ID on every failure after it answered", async () => {
    expect(await outcome("/traced/failure")).toMatchObject({
      failure: { _tag: "Forbidden", message: "Admins only", requestId: FAILED_ID },
    });
    expect(await outcome("/traced/garbage")).toMatchObject({
      failure: { _tag: "ProtocolError", requestId: GARBLED_ID },
    });
    expect(await outcome("/traced/wrong")).toMatchObject({
      failure: { _tag: "ProtocolError", requestId: WRONG_ID },
    });
    expect(await outcome("/traced/busy")).toMatchObject({
      failure: { _tag: "RateLimited", requestId: BUSY_ID },
    });
  });

  it("finds the media service's request ID in a header a proxy appended to", async () => {
    expect(await outcome("/traced/appended")).toMatchObject({
      failure: { _tag: "Forbidden", requestId: APPENDED_ID },
    });
  });

  it("drops a request ID the media service would not have sent, such as a proxy's", async () => {
    const [gateway, foreign, unsafe] = await Promise.all(
      ["/traced/gateway", "/traced/foreign", "/traced/unsafe"].map(outcome),
    );

    expect(gateway).toMatchObject({ failure: { _tag: "TransportError" } });
    expect(foreign).toMatchObject({ failure: { _tag: "Forbidden" } });
    expect(unsafe).toMatchObject({ failure: { _tag: "Forbidden" } });

    for (const result of [gateway, foreign, unsafe]) {
      expect(result).not.toHaveProperty("failure.requestId");
    }
  });
});

const linesOutcome = (path: string) =>
  Effect.runPromise(Effect.result(requestLines(request(path))));

describe("line-by-line requests", () => {
  it("answers with the headers, then the lines as they arrive", async () => {
    const lines = await Effect.runPromise(
      Effect.flatMap(requestLines(request("/lines")), (answer) =>
        Stream.runCollect(answer.lines).pipe(
          Effect.map((collected) => ({ header: answer.headers.get("x-test"), collected })),
        ),
      ),
    );

    expect(lines).toStrictEqual({ header: "yes", collected: ['{"n":1}', '{"n":2}'] });
    expect(received.at(-1)).toMatchObject({ auth: "Bearer secret-jwt" });
  });

  it("fails like a command when the service refuses", async () => {
    expect(await linesOutcome("/failure")).toMatchObject({
      failure: { _tag: "Forbidden", message: "Admins only" },
    });
  });

  it("carries the request ID of a refused or unreadable answer", async () => {
    expect(await linesOutcome("/traced/failure")).toMatchObject({
      failure: { _tag: "Forbidden", requestId: FAILED_ID },
    });
    expect(await linesOutcome("/traced/garbage")).toMatchObject({
      failure: { _tag: "ProtocolError", requestId: GARBLED_ID },
    });
  });
});

const playbackOutcome = (path: string) =>
  Effect.runPromise(Effect.result(requestPlayback(request(path), Ok)));

describe("playback API requests", () => {
  it("decodes the playback API's tagged failures into their errors", async () => {
    const gone = await playbackOutcome("/gone");

    expect(gone).toMatchObject({
      failure: new StreamGenerationGone({ streamId: "abc", generation: 1, currentGeneration: 2 }),
    });

    const expired = await playbackOutcome("/expired");

    expect(expired).toMatchObject({
      failure: new PlaybackTokenInvalid({ reason: "expired", message: "expired" }),
    });
  });

  it("reports a gateway failure as an unreachable service and unknown bodies as protocol errors", async () => {
    expect(await playbackOutcome("/gateway")).toMatchObject({
      failure: { _tag: "TransportError" },
    });
    expect(await playbackOutcome("/failure")).toMatchObject({
      failure: { _tag: "ProtocolError" },
    });
  });

  it("carries the request ID of a failure outside the playback API's contract", async () => {
    expect(await playbackOutcome("/traced/failure")).toMatchObject({
      failure: { _tag: "ProtocolError", requestId: FAILED_ID },
    });
    expect(await playbackOutcome("/traced/gateway")).toMatchObject({
      failure: { _tag: "TransportError" },
    });
    expect(await playbackOutcome("/traced/gateway")).not.toHaveProperty("failure.requestId");
  });

  it("says how a player recovers from each failure", () => {
    expect(
      recoveryFor(
        new StreamGenerationGone({ streamId: "abc", generation: 1, currentGeneration: 2 }),
      ),
    ).toBe("reload-playlist");
    expect(recoveryFor(new StreamNotFound({ streamId: "abc" }))).toBe("renegotiate");
    expect(recoveryFor(new TranscodeCapacityReached({ limit: 1 }))).toBe("retry-later");
    expect(recoveryFor(new PlaybackTokenInvalid({ reason: "expired", message: "x" }))).toBe(
      "renew-token",
    );
    expect(recoveryFor(new PlaybackTokenInvalid({ reason: "bad_signature", message: "x" }))).toBe(
      "fail",
    );
  });
});

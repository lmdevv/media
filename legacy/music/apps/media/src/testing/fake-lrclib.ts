/**
 * A stand-in for LRCLIB over real HTTP on a local port. Each test says how it answers, and it
 * records every request it received with the time it arrived, and how many the client hung up on
 * before the answer ended.
 */
import { createServer } from "node:http";

import { Effect, Schema } from "effect";

/** One request the stand-in received. */
interface FakeLrclibRequest {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly userAgent: string | undefined;
  /** When it arrived, in epoch milliseconds. */
  readonly at: number;
}

/** How the stand-in answers one request. */
export interface FakeLrclibReply {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Sends the status, headers, and body, then never ends the answer. */
  readonly stall?: boolean;
}

/** A reply carrying `value` as JSON. */
export const json = (
  status: number,
  value: Schema.Json,
  headers: Readonly<Record<string, string>> = {},
): FakeLrclibReply => ({ status, body: JSON.stringify(value), headers });

const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }));

export type FakeLrclibHandler = (
  request: FakeLrclibRequest,
) => FakeLrclibReply | Promise<FakeLrclibReply>;

/** A running stand-in. */
export interface FakeLrclib {
  readonly url: string;
  readonly requests: () => ReadonlyArray<FakeLrclibRequest>;
  /** Requests whose client closed the connection before the answer ended. */
  readonly hungUp: () => number;
}

/** Starts the stand-in for the current scope. */
export const fakeLrclib = (handler: FakeLrclibHandler) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const requests: Array<FakeLrclibRequest> = [];
      let hungUp = 0;

      const server = createServer((incoming, outgoing) => {
        const url = new URL(incoming.url ?? "/", "http://fake");

        const request: FakeLrclibRequest = {
          path: url.pathname,
          params: Object.fromEntries(url.searchParams),
          userAgent: incoming.headers["user-agent"],
          at: Date.now(),
        };

        requests.push(request);

        outgoing.on("close", () => {
          if (!outgoing.writableFinished) hungUp += 1;
        });

        void Promise.resolve(handler(request)).then((reply) => {
          outgoing.writeHead(reply.status, {
            "content-type": "application/json",
            ...reply.headers,
          });

          if (reply.stall === true) outgoing.write(reply.body);
          else outgoing.end(reply.body);

          return undefined;
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });

      const { port } = decodeAddress(server.address());

      return {
        server,
        fake: {
          url: `http://127.0.0.1:${port}`,
          requests: () => [...requests],
          hungUp: () => hungUp,
        },
      };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          }),
      ),
  ).pipe(Effect.map(({ fake }): FakeLrclib => fake));

/** LRCLIB's answer when nothing matches. */
export const NOT_FOUND = json(404, {
  message: "Failed to find specified track",
  name: "TrackNotFound",
  statusCode: 404,
});

/** An LRCLIB record as `/api/get` and `/api/search` return it. */
export const record = (fields: {
  readonly id: number;
  readonly trackName: string;
  readonly artistName: string;
  readonly albumName?: string;
  readonly duration: number;
  readonly instrumental?: boolean;
  readonly plainLyrics?: string | null;
  readonly syncedLyrics?: string | null;
}) => ({
  name: fields.trackName,
  albumName: "Album",
  instrumental: false,
  plainLyrics: null,
  syncedLyrics: null,
  ...fields,
});

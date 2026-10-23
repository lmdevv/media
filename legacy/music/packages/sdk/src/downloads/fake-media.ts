/**
 * Test support: a media service over real HTTP that serves finished files the way `&finished=1`
 * does (503 + Retry-After while preparing), and a server that signs URLs on it.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";

import { TrackId } from "@music/commands/ids";
import { StreamProfile } from "@music/commands/models";
import { Schema } from "effect";

import type { CommandTransport } from "../client";

const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }));

const decodeStreamArgs = Schema.decodeUnknownSync(
  Schema.Struct({ trackId: TrackId, profile: StreamProfile }),
);

/** One file the fake serves. */
interface Served {
  readonly body: Buffer;
  readonly contentType: string;
  /** `503` answers left before the file is ready. */
  preparing: number;
  /** Statuses to answer with before anything else, one per request. */
  readonly refusals: Array<number>;
}

/** A request the fake answered. */
interface Seen {
  readonly method: string;
  readonly url: string;
}

/** A media service on a free local port. */
export class FakeMedia {
  readonly #files = new Map<string, Served>();
  readonly #server: Server;
  readonly seen: Array<Seen> = [];

  constructor() {
    this.#server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fake");
      const method = request.method ?? "GET";
      this.seen.push({ method, url: request.url ?? "/" });
      const served = this.#files.get(url.pathname);

      if (served === undefined) {
        response.writeHead(404).end();

        return;
      }

      const refusal = served.refusals.shift();

      if (refusal !== undefined) {
        response.writeHead(refusal).end();

        return;
      }

      if (served.preparing > 0 && url.searchParams.get("finished") === "1") {
        served.preparing -= 1;
        response.writeHead(503, { "Retry-After": "2", "Cache-Control": "no-store" }).end();

        return;
      }

      response.writeHead(200, {
        "Content-Type": served.contentType,
        "Content-Length": String(served.body.length),
      });

      response.end(method === "HEAD" ? undefined : served.body);
    });
  }

  /** Starts listening; resolves with the base URL. */
  async listen(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.#server.listen(0, "127.0.0.1", resolve);
    });

    const { port } = decodeAddress(this.#server.address());

    return `http://127.0.0.1:${String(port)}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  /** Serves `body` at `path` after `preparing` answers of `503`, and first `refusals`. */
  serve(
    path: string,
    body: string,
    options: {
      readonly contentType?: string;
      readonly preparing?: number;
      readonly refusals?: ReadonlyArray<number>;
    } = {},
  ): void {
    this.#files.set(path, {
      body: Buffer.from(body),
      contentType: options.contentType ?? "audio/mp4",
      preparing: options.preparing ?? 0,
      refusals: [...(options.refusals ?? [])],
    });
  }
}

/** A mutation the server received. */
export interface Mutation {
  readonly name: string;
  readonly args: unknown;
}

/**
 * The server, at the Convex transport: `stream.url` signs a relative URL for the media service,
 * and every mutation is recorded in `mutations` and succeeds. Mutations named in `unanswered` are
 * recorded and never answered, as a Convex client queues them while offline.
 */
export const recordingTransport = (
  mutations: Array<Mutation>,
  unanswered: ReadonlySet<string> = new Set(),
): CommandTransport => ({
  query: (_reference, { args }) => {
    const { trackId, profile } = decodeStreamArgs(args);

    return Promise.resolve({
      trackId,
      url: `/media/stream/${trackId}?p=${profile}&exp=1&sig=s`,
      profile,
      expiresAt: Date.now() + 60_000,
    });
  },
  mutation: (_reference, { name, args }) => {
    mutations.push({ name, args });

    if (unanswered.has(name)) return new Promise(() => undefined);

    return Promise.resolve(name === "downloads.add" ? { pinId: "pin" } : { ok: true });
  },
});

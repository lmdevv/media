import { createServer } from "node:http";
import type { Server } from "node:http";

import { Schema } from "effect";

const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }));

/** One file the fake serves. */
interface Served {
  readonly body: Buffer;
  readonly contentType: string;
  /** `503` answers left before the file is ready. */
  preparing: number;
  /** Statuses to answer with before anything else, one per request. */
  readonly refusals: Array<number>;
  /** Sends half the body, then the rest once this resolves. */
  readonly held: Promise<void> | null;
}

/** A request the fake answered. */
interface Seen {
  readonly method: string;
  readonly url: string;
}

export class FakeMedia {
  readonly #files = new Map<string, Served>();
  readonly #server: Server;
  readonly seen: Array<Seen> = [];
  /** Body bytes sent, over every request. */
  bytesSent = 0;

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

      if (method === "HEAD") {
        response.end();

        return;
      }

      const half = Math.floor(served.body.length / 2);

      const send = (part: Buffer): void => {
        this.bytesSent += part.length;
        response.write(part);
      };

      if (served.held === null) {
        send(served.body);
        response.end();

        return;
      }

      const { held } = served;

      send(served.body.subarray(0, half));
      void (async () => {
        await held;

        if (response.destroyed) return;
        send(served.body.subarray(half));
        response.end();
      })();
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

  /**
   * Serves `body` at `path` after `preparing` answers of `503`, and first `refusals`; with `held`,
   * each answer sends half the body and the rest once `held` resolves.
   */
  serve(
    path: string,
    body: string,
    options: {
      readonly contentType?: string;
      readonly preparing?: number;
      readonly refusals?: ReadonlyArray<number>;
      readonly held?: Promise<void>;
    } = {},
  ): void {
    this.#files.set(path, {
      body: Buffer.from(body),
      contentType: options.contentType ?? "audio/mp4",
      preparing: options.preparing ?? 0,
      refusals: [...(options.refusals ?? [])],
      held: options.held ?? null,
    });
  }
}

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Schema } from "effect";

const ADDRESSES = 1 << 17;

const [first = 0] = crypto.getRandomValues(new Uint32Array(1));

/** Where this process starts counting, at random, so processes rarely share an address. */
const firstClient = first % ADDRESSES;

let clients = 0;

/** The `n`th address of 198.18.0.0/15, wrapping. */
const benchmarkAddress = (n: number): string => {
  const index = n % ADDRESSES;

  return `198.${String(18 + (index >> 16))}.${String((index >> 8) & 255)}.${String(index & 255)}`;
};

/**
 * A `fetch` that names its caller as a client of its own, as the proxy in front of the media
 * server does: every request carries `X-Forwarded-For` with one address from the benchmarking
 * range, 198.18.0.0/15, a new one for each `fetch` this makes, counted from a random start. The sign-in boundary limits sign-ins per address (ADR
 * 0007) and trusts the header from a loopback peer, so a suite that signs many people in from one
 * host passes this, and each person gets the budget a person on their own device has.
 */
export const ownClientFetch = (): typeof fetch => {
  clients += 1;
  const address = benchmarkAddress(firstClient + clients);

  return (input, init) => {
    const headers = new Headers(init?.headers);

    headers.set("x-forwarded-for", address);

    return fetch(input, { ...init, headers });
  };
};

/** A proxy in front of a sign-in boundary, and how to stop it. */
export interface OwnClientProxy {
  /** The boundary's address through the proxy. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

const Bound = Schema.Struct({ port: Schema.Finite });

const forward = async (
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  target: string,
): Promise<void> => {
  const chunks: Array<Buffer> = [];

  await new Promise<void>((resolve) => {
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", resolve);
  });

  const headers = new Headers();

  for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index]?.toLowerCase() ?? "";

    if (name !== "host" && name !== "content-length") {
      headers.append(name, incoming.rawHeaders[index + 1] ?? "");
    }
  }

  const init: RequestInit = { method: incoming.method ?? "GET", headers };
  const body = Buffer.concat(chunks);

  if (body.length > 0) init.body = body;

  try {
    const response = await ownClientFetch()(target, init);

    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(502);
    outgoing.end();
  }
};

/**
 * Starts a proxy on loopback that forwards every request to the boundary at `target` as a client
 * of its own, as `ownClientFetch` does, for a process that signs in with the global `fetch`, such
 * as the CLI under test.
 */
export const startOwnClientProxy = async (target: string): Promise<OwnClientProxy> => {
  const server = createServer((incoming, outgoing) => {
    void forward(incoming, outgoing, target);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = Schema.decodeUnknownSync(Bound)(server.address());

  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};

/**
 * Runs the stand-in LRCLIB (`lrclib-catalog.ts`) as its own process, for the live lanes and the
 * perf runs: test code. Old music and the server both point `LRCLIB_URL` at it.
 *
 *   node apps/media/src/music/lyrics/testing/fake-lrclib-main.ts --port 18090 --delay-ms 100
 *
 * Every answer waits `--delay-ms`. `GET /__requests` lists the requests it answered, `POST
 * /__reset` forgets them, `POST /__mode?status=429&retry_after=5` answers every lookup with that
 * status and `Retry-After` until `POST /__mode?status=200` turns the catalog back on.
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";

import { catalogReply } from "./lrclib-catalog.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "18090" },
    host: { type: "string", default: "0.0.0.0" },
    "delay-ms": { type: "string", default: "0" },
  },
});

const delayMs = Number(values["delay-ms"]);

interface Seen {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly userAgent: string | undefined;
  readonly at: number;
  readonly status: number;
}

const seen: Array<Seen> = [];

let refusal: { readonly status: number; readonly retryAfter: string | null } | null = null;

const server = createServer((incoming, outgoing) => {
  const url = new URL(incoming.url ?? "/", "http://fake");
  const params = Object.fromEntries(url.searchParams);

  const send = (status: number, body: string, headers: Record<string, string> = {}) => {
    outgoing.writeHead(status, { "content-type": "application/json", ...headers });
    outgoing.end(body);
  };

  if (url.pathname === "/__requests") return send(200, JSON.stringify(seen));

  if (url.pathname === "/__reset") {
    seen.length = 0;

    return send(200, "{}");
  }

  if (url.pathname === "/__mode") {
    const status = Number(params["status"] ?? "200");

    refusal = status === 200 ? null : { status, retryAfter: params["retry_after"] ?? null };

    return send(200, JSON.stringify({ refusal }));
  }

  setTimeout(() => {
    const reply =
      refusal === null
        ? catalogReply({ path: url.pathname, params })
        : { status: refusal.status, body: JSON.stringify({ message: "slow down" }) };

    seen.push({
      path: url.pathname,
      params,
      userAgent: incoming.headers["user-agent"],
      at: Date.now(),
      status: reply.status,
    });

    send(
      reply.status,
      reply.body,
      refusal?.retryAfter === null || refusal === null ? {} : { "retry-after": refusal.retryAfter },
    );
  }, delayMs);
});

server.listen(Number(values.port), values.host, () => {
  process.stdout.write(`fake LRCLIB on ${values.host}:${values.port}, ${delayMs} ms a request\n`);
});

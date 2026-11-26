import { createServer } from "node:http";
import type { Server } from "node:http";

import { Predicate } from "effect";

/** A route's JSON body, sent with status 200 at once or once its promise settles. */
export type RouteAnswer = string | (() => Promise<string>);

const servers: Array<Server> = [];

/**
 * Starts an HTTP server on a free loopback port that answers each path in `routes` and 404s every
 * other, and resolves with its base URL. `closeServers` stops every server started.
 */
export const startServer = async (
  routes: Readonly<Record<string, RouteAnswer>>,
): Promise<string> => {
  const server = createServer((request, response) => {
    const answer = routes[request.url ?? ""];

    if (answer === undefined) {
      response.writeHead(404).end();

      return;
    }

    const send = async (): Promise<void> => {
      const body = Predicate.isString(answer) ? answer : await answer();

      response.writeHead(200, { "content-type": "application/json" }).end(body);
    };

    void send();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();

  if (address === null || Predicate.isString(address)) throw new Error("Not listening on TCP");

  return `http://127.0.0.1:${address.port}`;
};

/** Stops every server `startServer` started. */
export const closeServers = (): void => {
  for (const server of servers.splice(0)) server.close();
};

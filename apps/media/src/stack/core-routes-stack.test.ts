import { join } from "node:path";

import { Effect, Exit, Option, Redacted, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeWorkDir, removeDir } from "../testing/core-host.ts";
import { core, issueServiceKey, personIn, startCoreServer } from "../testing/core-stack.ts";
import type { CoreServer, Person } from "../testing/core-stack.ts";

let scope: Scope.Closeable;

let workDir = "";

let libraryRoot = "";

let admin: Person;

let member: Person;

let server: CoreServer;

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const Failure = Schema.Struct({ code: Schema.String, message: Schema.String });

const decodeFailure = Schema.decodeUnknownSync(Failure);

const bearerOf = async (person: Person): Promise<string> =>
  Option.match(await run(person.platform.session.accessToken), {
    onNone: () => expect.unreachable("a signed-in person has a token"),
    onSome: Redacted.value,
  });

const post = (path: string, body: Schema.Json, bearer?: string) => {
  const headers = new Headers({ "content-type": "application/json" });

  if (bearer !== undefined) headers.set("authorization", `Bearer ${bearer}`);

  return fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

const unreachableJellyfin = {
  source: "jellyfin",
  url: "http://127.0.0.1:9",
  credentials: { kind: "token", token: "not-a-key" },
};

describe.skipIf(core === undefined)("the server's own routes on the core's sign-in", () => {
  beforeAll(async () => {
    scope = await run(Scope.make());
    workDir = await makeWorkDir("media-core-routes-");
    libraryRoot = workDir;
    admin = await personIn(scope, "admin");
    member = await personIn(scope, "member");

    server = await startCoreServer(scope, {
      serviceKey: await issueServiceKey(),
      libraryRoot,
      workDir: join(workDir, "server"),
    });
  }, 120_000);

  afterAll(async () => {
    await run(Scope.close(scope, Exit.void));
    await removeDir(workDir);
  }, 60_000);

  it("refuses a request with no token, and a token the core does not accept", async () => {
    const missing = await post("/api/libraries/folders", {});
    const refused = await post("/api/libraries/folders", {}, "not-a-convex-token");

    expect(missing.status).toBe(401);
    expect(refused.status).toBe(401);
    expect(decodeFailure(await refused.json()).code).toBe("unauthenticated");
  });

  it("lets only owners and admins browse the server's folders", async () => {
    const asMember = await post("/api/libraries/folders", {}, await bearerOf(member));
    const asAdmin = await post("/api/libraries/folders", {}, await bearerOf(admin));

    expect(asMember.status).toBe(403);
    expect(asAdmin.status, await asAdmin.clone().text()).toBe(200);
    expect(JSON.stringify(await asAdmin.json())).toContain(libraryRoot);
  });

  it("serves the retained log and the importer to admins only", async () => {
    const memberToken = await bearerOf(member);
    const adminToken = await bearerOf(admin);

    expect((await post("/api/logs", {}, memberToken)).status).toBe(403);
    expect((await post("/api/logs", {}, adminToken)).status).toBe(200);
    expect((await post("/api/imports/connect", unreachableJellyfin, memberToken)).status).toBe(403);

    const connect = await post("/api/imports/connect", unreachableJellyfin, adminToken);

    expect(connect.status, await connect.clone().text()).toBe(200);
    expect(await connect.json()).toMatchObject({ status: "failed", reason: "unreachable" });
  });

  it("checks a metadata search's caller with movies:edit before it asks the provider", async () => {
    const searched = await post(
      "/api/metadata/candidates",
      { titleId: "no-such-title", query: "Big Buck Bunny" },
      await bearerOf(member),
    );

    expect([401, 403]).not.toContain(searched.status);
    expect((await post("/api/metadata/candidates", { titleId: "t", query: "x" })).status).toBe(401);
  });

  it("writes any signed-in person's error report to the log with their core user", async () => {
    const reported = await post(
      "/api/client-errors",
      {
        platform: "web",
        appVersion: "test",
        kind: "render",
        route: "/movies",
        name: "Error",
        message: "a report from the routes suite",
      },
      await bearerOf(member),
    );

    expect(reported.status, await reported.clone().text()).toBe(204);

    const userId = (await run(member.platform.core.auth.sessions.current())).userId;

    expect(
      server
        .logged()
        .some((line) => line.includes("a report from the routes suite") && line.includes(userId)),
    ).toBe(true);
  });
});

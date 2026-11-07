import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { logMark, logTextSince, runFunction } from "../../admin";
import { createPerson, ensureOwner, refusal, signIn, signInAs, unique } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import type { CoreStack } from "../../stack-env";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered this one as a `users` id; the backend's `v.id("users")` validators check it
// again whenever a test sends it back.
const isUserId = (value: unknown): value is Id<"users"> => Schema.is(Schema.String)(value);

// SAFETY: as `isUserId`, for the session id Convex Auth put in a token it minted; the probe's
// `v.id("authSessions")` validator checks it again.
const isSessionId = (value: unknown): value is Id<"authSessions"> =>
  Schema.is(Schema.String)(value);

const UserId = Schema.declare(isUserId);

const SessionId = Schema.declare(isSessionId);

const Issued = Schema.Struct({ keyId: Schema.String, key: Schema.String });

const Service = Schema.Struct({
  name: Schema.String,
  scopes: Schema.Array(Schema.Literal("media-service")),
});

const Claims = Schema.fromJsonString(Schema.Struct({ sub: Schema.String }));

const decodeClaims = Schema.decodeUnknownSync(Claims);

const decodeSessionId = Schema.decodeUnknownSync(SessionId);

/** The session a token stands for: Convex Auth's subject is `<userId>|<sessionId>`. */
const sessionIdOf = (signedIn: SignedIn): Id<"authSessions"> => {
  const payload = Buffer.from(signedIn.token.split(".")[1] ?? "", "base64url").toString("utf8");
  const { sub } = decodeClaims(payload);

  return decodeSessionId(sub.slice(sub.indexOf("|") + 1));
};

const createService = (core: CoreStack): Promise<Id<"users">> =>
  runFunction(
    core,
    internal.core.accounts.host.createService,
    { name: `media server ${unique()}` },
    UserId,
  );

const issue = (
  core: CoreStack,
  serviceId: Id<"users">,
  retire?: "on-first-use" | "now",
): Promise<typeof Issued.Type> =>
  runFunction(
    core,
    internal.core.auth.apiKeys.issueServiceKey,
    retire === undefined ? { serviceId } : { serviceId, retire },
    Issued,
  );

const signInWith = (core: CoreStack, issued: typeof Issued.Type): Promise<SignedIn> =>
  signIn(core, "apiKey", { key: issued.key });

const whoami = (core: CoreStack, signedIn: SignedIn): Promise<typeof Service.Type> =>
  runFunction(
    core,
    internal.core.serviceProbe.whoami,
    { sessionId: sessionIdOf(signedIn) },
    Service,
  );

describe.skipIf(stack === undefined)("service keys", { timeout: 120_000 }, () => {
  it("sign a service in holding media-service, and a newer key's first sign-in retires older ones", async () => {
    if (stack === undefined) return;
    const serviceId = await createService(stack);
    const first = await issue(stack, serviceId);
    const running = await signInWith(stack, first);

    expect((await whoami(stack, running)).scopes).toEqual(["media-service"]);

    const second = await issue(stack, serviceId);

    expect(await refusal(whoami(stack, running))).toBe("accepted");
    expect(await refusal(signInWith(stack, first))).toBe("accepted");

    const restarted = await signInWith(stack, second);

    expect(await refusal(whoami(stack, restarted))).toBe("accepted");
    expect(await refusal(signInWith(stack, first))).toBe("unauthenticated");
    expect(await refusal(whoami(stack, running))).toBe("unauthenticated");
    expect(await refusal(signInWith(stack, second))).toBe("accepted");
  });

  it("end every earlier key and its sessions at once when issued with retire now", async () => {
    if (stack === undefined) return;
    const serviceId = await createService(stack);
    const leaked = await issue(stack, serviceId);
    const pending = await issue(stack, serviceId);
    const running = await signInWith(stack, leaked);

    const replacement = await issue(stack, serviceId, "now");

    expect(await refusal(whoami(stack, running))).toBe("unauthenticated");
    expect(await refusal(signInWith(stack, leaked))).toBe("unauthenticated");
    expect(await refusal(signInWith(stack, pending))).toBe("unauthenticated");
    expect(await refusal(signInWith(stack, replacement))).toBe("accepted");
  });

  it("stop at four keys waiting for a sign-in until the newest signs in or retire now", async () => {
    if (stack === undefined) return;
    const serviceId = await createService(stack);
    const keys = await inOrder([1, 2, 3, 4], () => issue(stack, serviceId));

    expect(await refusal(issue(stack, serviceId))).toBe("conflict");

    const newest = keys.at(-1);

    if (newest === undefined) throw new Error("Issued no keys");
    await signInWith(stack, newest);

    expect(await refusal(issue(stack, serviceId))).toBe("accepted");
    expect(await refusal(issue(stack, serviceId, "now"))).toBe("accepted");
  });

  it("are issued only to a service", async () => {
    if (stack === undefined) return;
    await ensureOwner(stack);

    const personId = await runFunction(
      stack,
      internal.core.accounts.host.createUser,
      { username: `person-${unique()}`, password: `password-${unique()}`, role: "member" },
      UserId,
    );

    expect(await refusal(issue(stack, personId))).toBe("not_found");
  });

  it("run no command, and the service check refuses a person's sessions", async () => {
    if (stack === undefined) return;
    const service = await signInWith(stack, await issue(stack, await createService(stack)));

    expect(
      await Promise.all([
        refusal(service.client.query(api.core.auth.sessions.current, {})),
        refusal(
          service.client.query(api.core.libraries.list, {
            paginationOpts: { numItems: 10, cursor: null },
          }),
        ),
        refusal(service.client.action(api.core.auth.apiKeys.create, { name: "copy", scopes: [] })),
      ]),
    ).toEqual(["forbidden", "forbidden", "forbidden"]);

    const owner = await signInAs(stack, await createPerson(stack, "owner", "admin"));

    const { key } = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "script",
      scopes: ["account"],
    });

    expect(
      await Promise.all([
        refusal(whoami(stack, owner)),
        refusal(whoami(stack, await signIn(stack, "apiKey", { key }))),
      ]),
    ).toEqual(["forbidden", "forbidden"]);
  });

  it("cannot be made by a person, who cannot name media-service", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack, "owner", "admin"));

    const create = makeFunctionReference<"action", Readonly<Record<string, Value>>, unknown>(
      "core/auth/apiKeys:create",
    );

    expect(
      await refusal(owner.client.action(create, { name: "server", scopes: ["media-service"] })),
    ).toMatch(/^failed: .*ArgumentValidationError/su);
  });

  it("leave neither a key nor its secret in the function log", async () => {
    if (stack === undefined) return;
    const mark = await logMark(stack);
    const serviceId = await createService(stack);
    const first = await issue(stack, serviceId);
    const running = await signInWith(stack, first);
    const second = await issue(stack, serviceId);
    const restarted = await signInWith(stack, second);

    expect(await refusal(signInWith(stack, first))).toBe("unauthenticated");
    expect(await refusal(whoami(stack, running))).toBe("unauthenticated");
    await whoami(stack, restarted);

    const logged = await logTextSince(stack, mark, internal.core.serviceProbe.whoami);

    expect(logged).toContain("core/auth/apiKeys:redeem");
    expect(logged).toContain("core/auth/apiKeys:issueServiceKey");

    for (const { key } of [first, second]) {
      const secret = key.slice(key.indexOf(".") + 1);

      expect(logged.includes(key)).toBe(false);
      expect(logged.includes(secret)).toBe(false);
    }
  });
});

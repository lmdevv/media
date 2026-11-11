import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Platform, TokenStorage } from "@media/sdk/effect";
import { ownClientFetch } from "@media/sdk/testing/own-client";
import { Context, Effect, Exit, Layer, Logger, Option, Redacted, References, Schema } from "effect";
import type { Scope } from "effect";

import * as CoreWiring from "../core/core-wiring.ts";
import * as CoreImports from "../migration/core-imports.ts";
import * as Outbound from "../http/outbound.ts";
import * as SignInPasses from "../http/sign-in-passes.ts";
import * as RetainedLogs from "../logging/retained-logs.ts";
import * as MediaConfig from "../media-config.ts";
import { redactedLine } from "../observability.ts";
import { freePort, ticketKeysText } from "./core-host.ts";
import { findCoreStack } from "./stack-processes.ts";
import { testConfigLayer } from "./test-config.ts";

/** The dev stack's core, or undefined outside the stack suite. */
export const core = findCoreStack();

const coreUrl = (): string => core?.url ?? "";

const HostAnswer = Schema.fromJsonString(
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.Unknown }),
);

/** Runs a host (internal) function on the core with its admin key, as the operator would. */
export const runHost = async <A>(
  path: string,
  args: Readonly<Record<string, Schema.Json>>,
  result: Schema.Decoder<A>,
): Promise<A> => {
  const response = await fetch(`${coreUrl()}/api/function`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Convex ${core?.adminKey ?? ""}`,
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });

  const text = await response.text();
  const answer = Schema.decodeExit(HostAnswer)(text);

  if (Exit.isFailure(answer)) throw new Error(`${path} failed: ${text.slice(0, 500)}`);

  return Schema.decodeUnknownSync(result)(answer.value.value);
};

/** Passes for the server's own sign-in, signed with the stack core's ticket keys. */
export const stackPasses: Layer.Layer<SignInPasses.Passes, SignInPasses.PassKeysUnusable> =
  Layer.unwrap(Effect.sync(() => SignInPasses.layer(Redacted.make(ticketKeysText()))));

/** A new service principal and the key the operator issues it. */
export const issueServiceKey = async (): Promise<Redacted.Redacted> => {
  const serviceId = await runHost(
    "core/accounts/host:createService",
    { name: `media server ${crypto.randomUUID().slice(0, 8)}` },
    Schema.String,
  );

  const { key } = await runHost(
    "core/auth/apiKeys:issueServiceKey",
    { serviceId },
    Schema.Struct({ key: Schema.String }),
  );

  return Redacted.make(key);
};

/** Signs `username` in over a new client that closes with `scope`. */
const signIn = (scope: Scope.Scope, username: string, password: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(
        Platform.layer({
          url: coreUrl(),
          connection: "http",
          storage: TokenStorage.layerMemory,
          signIn: Platform.SignInRoute.Boundary({
            url: core?.signInUrl ?? "",
            fetch: ownClientFetch(),
          }),
        }),
        scope,
      );

      const platform = Context.get(context, Platform.Platform);

      yield* platform.session.signIn(
        Platform.Credentials.Password({ username, password: Redacted.make(password) }),
      );

      return platform;
    }),
  );

/** A person on the core with a password, signed in over a client of their own. */
export interface Person {
  readonly username: string;
  readonly password: string;
  readonly platform: Platform.Interface;
}

const setUpOwner = (url: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Platform.layer({
            url,
            connection: "http",
            storage: TokenStorage.layerMemory,
            signIn: Platform.SignInRoute.Boundary({
              url: core?.signInUrl ?? "",
              fetch: ownClientFetch(),
            }),
          }),
        );

        const platform = Context.get(context, Platform.Platform);

        if ((yield* platform.core.server.info()).hasOwner) return;

        yield* platform.session
          .signIn(
            Platform.Credentials.Setup({
              username: `owner${crypto.randomUUID().slice(0, 8)}`,
              password: Redacted.make(`password-${crypto.randomUUID()}`),
            }),
          )
          .pipe(Effect.catchTag("Conflict", () => Effect.void));
      }),
    ),
  );

const owners = new Map<string, Promise<void>>();

/** Sets up the core's owner unless it has one, once per stack; the core refuses users before it. */
const ensureOwner = (): Promise<void> => {
  const url = coreUrl();
  const setUp = owners.get(url) ?? setUpOwner(url);

  owners.set(url, setUp);

  return setUp;
};

/** Creates a person with `role` and signs them in; the client closes with `scope`. */
export const personIn = async (
  scope: Scope.Scope,
  role: "admin" | "member",
  name: string = role,
): Promise<Person> => {
  const person = {
    username: `${name}${crypto.randomUUID().slice(0, 8)}`,
    password: `password-${crypto.randomUUID()}`,
  };

  const { username, password } = person;

  await ensureOwner();
  await runHost("core/accounts/host:createUser", { username, password, role }, Schema.String);

  const platform = await signIn(scope, username, password);

  return { username, password, platform };
};

/** An in-process server on the core, listening on `baseUrl`. */
export interface CoreServer {
  readonly baseUrl: string;
  readonly imports: CoreImports.Interface;
  /** Every log line so far, redacted as the server redacts its log. */
  readonly logged: () => ReadonlyArray<string>;
}

/**
 * Starts the server on the core's adapters in this process, signed in with `serviceKey`, with
 * `libraryRoot` approved and its own data and transcode folders under `workDir`. It stops when
 * `scope` closes.
 */
export const startCoreServer = async (
  scope: Scope.Scope,
  options: {
    readonly serviceKey: Redacted.Redacted;
    readonly libraryRoot: string;
    readonly workDir: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<CoreServer> => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const logged: Array<string> = [];

  const config = testConfigLayer({
    PORT: String(port),
    HOST: "127.0.0.1",
    MEDIA_BASE_URL: baseUrl,
    LIBRARY_ROOTS: options.libraryRoot,
    DATA_DIR: join(options.workDir, "data"),
    TRANSCODE_DIR: join(options.workDir, "transcode"),
    BACKUP_DIR: join(options.workDir, "backups"),
    MIN_FREE_TRANSCODE_MB: "1",
    LOG_LEVEL: "debug",
    ...options.env,
  });

  const server = CoreWiring.layer({
    coreUrl: coreUrl(),
    serviceKey: options.serviceKey,
    ticketKeys: Redacted.make(ticketKeysText()),
  }).pipe(
    Layer.provideMerge(RetainedLogs.layer),
    Layer.provide(config),
    Layer.provide(Layer.mergeAll(NodeServices.layer, Outbound.layer)),
    Layer.provide(
      Layer.mergeAll(
        Logger.layer([Logger.map(redactedLine, (line) => logged.push(line))], {
          mergeWithExisting: false,
        }),
        Layer.effect(
          References.MinimumLogLevel,
          Effect.map(MediaConfig.Service, (settings) => settings.logs.level),
        ).pipe(Layer.provide(config)),
      ),
    ),
  );

  const built = await Effect.runPromise(Layer.buildWithScope(server, scope));

  return { baseUrl, imports: Context.get(built, CoreImports.Service), logged: () => logged };
};

/** Waits until `check` answers some value, trying every `everyMs` for up to `timeoutMs`. */
export const eventually = <A>(
  what: string,
  check: () => Promise<Option.Option<A>>,
  timeoutMs = 60_000,
  everyMs = 500,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs;

  const attempt = async (): Promise<A> => {
    const found = await check();

    if (Option.isSome(found)) return found.value;

    if (Date.now() > deadline) throw new Error(`Timed out after ${String(timeoutMs)} ms: ${what}`);

    await new Promise((resolve) => setTimeout(resolve, everyMs));

    return attempt();
  };

  return attempt();
};

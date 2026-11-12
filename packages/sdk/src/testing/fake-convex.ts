/**
 * A fake Convex deployment that speaks the HTTP protocol `ConvexHttpClient` uses: `POST
 * /api/query`, `/api/mutation`, and `/api/action` with a JSON body of `{ path, format, args: [args]
 * }`, answered with `{ status: "success", value }` or, with status 560, `{ status: "error",
 * errorMessage, errorData }`. Convex rejecting the auth token itself is a 401 whose text body is `{
 * code, message }`. Tests script replies per function path and read back every request with its
 * arguments and `Authorization` header. Unscripted functions answer the way Convex answers an
 * unknown function: a server error.
 *
 * It also speaks enough of the WebSocket sync protocol for `ConvexClient` queries: it accepts a
 * `User` token while its `exp` lies ahead, answers `ModifyQuerySet` additions through the same
 * handlers, and treats a token Convex would no longer accept the way Convex does, by closing the
 * connection without a close frame or an `AuthError`; `rejectAcceptedTokens` sends the `AuthError`
 * instead. Mutations and actions are HTTP-only here.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";

import type { ErrorCode } from "@media/contracts/errors";
import { SIGN_IN_PATH, signInRefusalStatus } from "@media/contracts/sign-in";
import { Data, Effect, Option, Predicate, Schema } from "effect";
import type { Scope } from "effect";

import type { IssuedToken } from "../convex-transport";

type CallKind = "query" | "mutation" | "action";

/** One call the fake received, with its bearer token header when it carried one. */
export interface RecordedRequest {
  readonly kind: CallKind;
  readonly path: string;
  readonly args: Schema.Json;
  readonly authorization: string | undefined;
}

/** What the fake answers a call with. */
export type Reply = Data.TaggedEnum<{
  /** The function returned `value`. */
  Success: { readonly value: Schema.Json };
  /**
   * The function threw `ConvexError({ code, message })`. The platform's device code provider
   * also answers `pending` and `denied`.
   */
  Failure: { readonly code: ErrorCode | "pending" | "denied"; readonly message: string };
  /** The function crashed with an uncaught error. */
  Crash: { readonly message: string };
  /** Convex could not verify the auth token and ran nothing. */
  TokenRejected: {};
  /** The connection drops before any answer, as when the server is unreachable. */
  Drop: {};
}>;

/** Constructors for `Reply`. */
export const Reply = Data.taggedEnum<Reply>();

type Handler = (request: RecordedRequest) => Effect.Effect<Reply>;

/** The fake deployment and its test controls. */
export interface FakeConvex {
  /** The deployment URL to hand the SDK. */
  readonly url: string;
  /**
   * A sign-in boundary in front of the fake, as the media server's (`@media/contracts/sign-in`):
   * it records each sign-in as a call to `auth:signIn` and answers as the boundary relays.
   */
  readonly signInUrl: string;
  /** Answers every later call to `path` with `handler`, replacing any earlier one. */
  readonly handle: (path: string, handler: Handler) => Effect.Effect<void>;
  /** Answers every later call to `path` with `reply`. */
  readonly reply: (path: string, reply: Reply) => Effect.Effect<void>;
  /** Every call received so far, in arrival order. */
  readonly requests: Effect.Effect<ReadonlyArray<RecordedRequest>>;
  /** The calls received so far to `path`. */
  readonly requestsTo: (path: string) => Effect.Effect<ReadonlyArray<RecordedRequest>>;
  /** Every token a sync connection accepted, in order, repeats included. */
  readonly acceptedTokens: Effect.Effect<ReadonlyArray<string>>;
  /**
   * Refuses every token accepted so far and closes every sync connection, as Convex does once a
   * token expires: the client reconnects presenting the same token and is cut off again.
   */
  readonly refuseAcceptedTokens: Effect.Effect<void>;
  /**
   * Refuses every token accepted so far and sends an `AuthError` on each sync connection that
   * presents one, as Convex does when a token stops verifying while its connection stays open.
   */
  readonly rejectAcceptedTokens: Effect.Effect<void>;
  /**
   * From now on, answers every token a sync connection presents with an `AuthError`, as Convex
   * does a token it cannot verify, such as one signed by another deployment.
   */
  readonly rejectEveryToken: Effect.Effect<void>;
  /** The most queries to `path` that one sync connection has subscribed to at once. */
  readonly peakSubscriptions: (path: string) => Effect.Effect<number>;
}

const RequestBody = Schema.fromJsonString(
  Schema.Struct({ path: Schema.String, args: Schema.Array(Schema.Json) }),
);

const decodeBody = Schema.decodeUnknownOption(RequestBody);

const kindOf = (url: string | undefined): CallKind | undefined => {
  if (url === "/api/query") return "query";

  if (url === "/api/mutation") return "mutation";

  return url === "/api/action" ? "action" : undefined;
};

/** The status Convex uses for a function that ran and failed. */
const FUNCTION_FAILED = 560;

const send = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
};

const SignInBody = Schema.fromJsonString(
  Schema.Struct({ provider: Schema.String, params: Schema.Json }),
);

const decodeSignIn = Schema.decodeUnknownOption(SignInBody);

/** Answers a sign-in at the boundary as the media server relays the core's answer. */
const writeBoundary = (response: ServerResponse, reply: Reply): void =>
  Reply.$match(reply, {
    Success: ({ value }) => send(response, 200, JSON.stringify(value)),
    Failure: ({ code, message }) =>
      send(response, signInRefusalStatus[code], JSON.stringify({ code, message })),
    Crash: () =>
      send(
        response,
        500,
        JSON.stringify({ code: "internal", message: "The core failed while signing in" }),
      ),
    TokenRejected: () =>
      send(response, 401, JSON.stringify({ code: "unauthenticated", message: "Refused" })),
    Drop: () => {
      response.socket?.destroy();
    },
  });

const write = (response: ServerResponse, reply: Reply): void =>
  Reply.$match(reply, {
    Success: ({ value }) =>
      send(response, 200, JSON.stringify({ status: "success", value, logLines: [] })),
    Failure: ({ code, message }) =>
      send(
        response,
        FUNCTION_FAILED,
        JSON.stringify({
          status: "error",
          errorMessage: message,
          errorData: { code, message },
          logLines: [],
        }),
      ),
    Crash: ({ message }) =>
      send(
        response,
        FUNCTION_FAILED,
        JSON.stringify({
          status: "error",
          errorMessage: `[Request ID: fake] Server Error\nUncaught Error: ${message}`,
          logLines: [],
        }),
      ),
    TokenRejected: () =>
      send(
        response,
        401,
        JSON.stringify({ code: "Unauthenticated", message: "Could not verify OIDC token claim" }),
      ),
    Drop: () => {
      response.socket?.destroy();
    },
  });

const jwtPart = (value: Schema.Json): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A JWT with the claims Convex Auth signs, to the second as Convex Auth does: the same `sub` and
 * `issuedAt` second always give the same token. `ConvexClient` reads `iat` and `exp` to schedule
 * its refresh.
 */
export const jwtIssuedAt = (issuedAt: number, lifetimeSeconds: number, subject: string): string => {
  const iat = Math.floor(issuedAt / 1000);

  return `${jwtPart({ alg: "none" })}.${jwtPart({ sub: subject, iat, exp: iat + lifetimeSeconds })}.fake`;
};

/** A JWT that only carries `exp`, enough for the SDK to read when it expires. */
export const jwtExpiringAt = (epochMillis: number, subject = "user"): string =>
  `${jwtPart({ alg: "none" })}.${jwtPart({ exp: Math.floor(epochMillis / 1000), sub: subject })}.fake`;

/** `token` as a token source hands it out, outside any session. */
export const issuedOf = (token: string): IssuedToken => ({
  token,
  session: Option.none(),
  generation: 0,
});

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE_TEXT = 0x1;

const OPCODE_CLOSE = 0x8;

const OPCODE_PING = 0x9;

const OPCODE_PONG = 0xa;

interface Frame {
  readonly opcode: number;
  readonly payload: Buffer;
}

interface ReadFrames {
  readonly frames: ReadonlyArray<Frame>;
  /** The start of a frame that has not fully arrived. */
  readonly rest: Buffer;
}

/** How many bytes after the first two give the payload length, by the 7-bit length. */
const extendedLengthBytes = (short: number): number => {
  if (short === 126) return 2;

  return short === 127 ? 8 : 0;
};

const payloadLength = (buffer: Buffer, offset: number, short: number): number => {
  if (short === 126) return buffer.readUInt16BE(offset + 2);

  return short === 127 ? Number(buffer.readBigUInt64BE(offset + 2)) : short;
};

/**
 * Splits the complete frames off the front of `buffer`, unmasked. The Convex client sends each
 * message as one frame, so continuation frames never arrive.
 */
const readFrames = (buffer: Buffer): ReadFrames => {
  const frames: Array<Frame> = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const opcode = buffer.readUInt8(offset) & 0x0f;
    const second = buffer.readUInt8(offset + 1);
    const short = second & 0x7f;
    const maskStart = offset + 2 + extendedLengthBytes(short);
    const payloadStart = maskStart + ((second & 0x80) === 0 ? 0 : 4);

    if (buffer.length < payloadStart) break;

    const length = payloadLength(buffer, offset, short);

    if (buffer.length < payloadStart + length) break;
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));

    if (payloadStart > maskStart) {
      for (let index = 0; index < payload.length; index += 1) {
        payload.writeUInt8(
          payload.readUInt8(index) ^ buffer.readUInt8(maskStart + (index % 4)),
          index,
        );
      }
    }

    frames.push({ opcode, payload });
    offset = payloadStart + length;
  }

  return { frames, rest: buffer.subarray(offset) };
};

const writeFrame = (socket: Duplex, opcode: number, payload: Buffer): void => {
  const first = 0x80 | opcode;
  let header: Buffer;

  if (payload.length < 126) {
    header = Buffer.from([first, payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header.writeUInt8(first, 0);
    header.writeUInt8(126, 1);
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header.writeUInt8(first, 0);
    header.writeUInt8(127, 1);
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  socket.write(Buffer.concat([header, payload]));
};

const AddQuery = Schema.Struct({
  type: Schema.Literal("Add"),
  queryId: Schema.Int,
  udfPath: Schema.String,
  args: Schema.Array(Schema.Json),
});

const RemoveQuery = Schema.Struct({ type: Schema.Literal("Remove"), queryId: Schema.Int });

const SyncMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("Authenticate"),
    tokenType: Schema.String,
    value: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("ModifyQuerySet"),
    newVersion: Schema.Int,
    modifications: Schema.Array(Schema.Union([AddQuery, RemoveQuery])),
  }),
]);

type SyncMessage = typeof SyncMessage.Type;

const decodeSyncMessage = Schema.decodeUnknownOption(Schema.fromJsonString(SyncMessage));

const TokenClaims = Schema.Struct({ exp: Schema.Finite });

const decodeTokenClaims = Schema.decodeUnknownOption(Schema.fromJsonString(TokenClaims));

const isUnexpired = (token: string, now: number): boolean => {
  const [, payload] = token.split(".");

  return (
    payload !== undefined &&
    Option.exists(
      decodeTokenClaims(Buffer.from(payload, "base64url").toString("utf8")),
      (claims) => claims.exp * 1000 > now,
    )
  );
};

/** A sync timestamp as the protocol carries it: eight little-endian bytes in base64. */
const encodeTs = (ts: number): string => {
  const bytes = Buffer.alloc(8);

  bytes.writeBigUInt64LE(BigInt(ts));

  return bytes.toString("base64");
};

const queryModification = (queryId: number, reply: Reply): Option.Option<Schema.Json> =>
  Reply.$match(reply, {
    Success: ({ value }) =>
      Option.some({ type: "QueryUpdated", queryId, value, logLines: [], journal: null }),
    Failure: ({ code, message }) =>
      Option.some({
        type: "QueryFailed",
        queryId,
        errorMessage: message,
        errorData: { code, message },
        logLines: [],
        journal: null,
      }),
    Crash: ({ message }) =>
      Option.some({
        type: "QueryFailed",
        queryId,
        errorMessage: `[Request ID: fake] Server Error\nUncaught Error: ${message}`,
        logLines: [],
        journal: null,
      }),
    TokenRejected: () => Option.none(),
    Drop: () => Option.none(),
  });

/** Starts the fake on a free local port; it stops when the scope closes. */
export const make: Effect.Effect<FakeConvex, never, Scope.Scope> = Effect.gen(function* () {
  const context = yield* Effect.context();
  const handlers = new Map<string, Handler>();
  const received: Array<RecordedRequest> = [];
  const accepted: Array<string> = [];
  const refused = new Set<string>();
  const syncSockets = new Set<Duplex>();
  const authErrorSenders = new Set<() => void>();
  const peaks = new Map<string, number>();

  const answer = (request: RecordedRequest): Effect.Effect<Reply> =>
    Option.match(Option.fromNullishOr(handlers.get(request.path)), {
      onNone: () =>
        Effect.succeed(
          Reply.Crash({ message: `Could not find public function for '${request.path}'` }),
        ),
      onSome: (handler) => handler(request),
    });

  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    let text = "";

    incoming.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });

    incoming.on("end", () => {
      if (incoming.url === SIGN_IN_PATH && incoming.method === "POST") {
        const signIn = decodeSignIn(text);

        if (Option.isNone(signIn)) {
          send(response, 400, JSON.stringify({ code: "invalid_args", message: "Not a sign-in" }));

          return;
        }

        const request: RecordedRequest = {
          kind: "action",
          path: "auth:signIn",
          args: { provider: signIn.value.provider, params: signIn.value.params },
          authorization: incoming.headers.authorization,
        };

        received.push(request);

        void Effect.runPromiseWith(context)(answer(request)).then(
          (reply) => writeBoundary(response, reply),
          (cause: unknown) => writeBoundary(response, Reply.Crash({ message: String(cause) })),
        );

        return;
      }

      const kind = kindOf(incoming.url);
      const body = decodeBody(text);

      if (kind === undefined || Option.isNone(body)) {
        send(response, 404, "Not found");

        return;
      }

      const request: RecordedRequest = {
        kind,
        path: body.value.path,
        args: body.value.args[0] ?? null,
        authorization: incoming.headers.authorization,
      };

      received.push(request);

      void Effect.runPromiseWith(context)(answer(request)).then(
        (reply) => write(response, reply),
        (cause: unknown) => write(response, Reply.Crash({ message: String(cause) })),
      );
    });
  });

  const accepts = (token: string): boolean => !refused.has(token) && isUnexpired(token, Date.now());

  const rejecting = { every: false };

  const openSync = (socket: Duplex, head: Buffer): void => {
    let pending: Buffer = Buffer.alloc(0);
    let queue = Promise.resolve();
    let version = { querySet: 0, identity: 0, ts: 0 };
    let token: string | undefined;
    const subscribed = new Map<number, { readonly path: string; readonly args: Schema.Json }>();

    const sendAuthError = (): void => {
      if (token === undefined || accepts(token)) return;

      const error = {
        type: "AuthError",
        error: "Convex token identity expired",
        baseVersion: version.identity,
        authUpdateAttempted: false,
      };

      writeFrame(socket, OPCODE_TEXT, Buffer.from(JSON.stringify(error)));
    };

    syncSockets.add(socket);
    authErrorSenders.add(sendAuthError);
    socket.on("close", () => {
      syncSockets.delete(socket);
      authErrorSenders.delete(sendAuthError);
    });
    socket.on("error", () => socket.destroy());

    const transition = (
      next: { readonly querySet: number; readonly identity: number },
      modifications: ReadonlyArray<Schema.Json>,
    ): void => {
      const start = version;

      version = { ...next, ts: start.ts + 1 };

      const message = {
        type: "Transition",
        startVersion: { ...start, ts: encodeTs(start.ts) },
        endVersion: { ...version, ts: encodeTs(version.ts) },
        modifications,
      };

      writeFrame(socket, OPCODE_TEXT, Buffer.from(JSON.stringify(message)));
    };

    const answerQuery = async (
      queryId: number,
      query: { readonly path: string; readonly args: Schema.Json },
    ): Promise<Option.Option<Schema.Json>> => {
      const request: RecordedRequest = {
        kind: "query",
        path: query.path,
        args: query.args,
        authorization: token === undefined ? undefined : `Bearer ${token}`,
      };

      received.push(request);

      return queryModification(queryId, await Effect.runPromiseWith(context)(answer(request)));
    };

    const handle = async (message: SyncMessage): Promise<void> => {
      if (message.type === "Authenticate") {
        if (message.value !== undefined && rejecting.every) {
          const error = {
            type: "AuthError",
            error: "Could not verify OIDC token claim",
            baseVersion: version.identity,
            authUpdateAttempted: true,
          };

          writeFrame(socket, OPCODE_TEXT, Buffer.from(JSON.stringify(error)));

          return;
        }

        if (message.value !== undefined && !accepts(message.value)) {
          socket.destroy();

          return;
        }

        token = message.value;

        if (token !== undefined) accepted.push(token);

        // Convex runs every subscribed query again as the new identity.
        const rerun = Option.all(
          await Promise.all([...subscribed].map(([queryId, query]) => answerQuery(queryId, query))),
        );

        if (Option.isNone(rerun)) {
          socket.destroy();

          return;
        }

        transition({ querySet: version.querySet, identity: version.identity + 1 }, rerun.value);

        return;
      }

      if (token !== undefined && !accepts(token)) {
        socket.destroy();

        return;
      }

      for (const change of message.modifications) {
        if (change.type === "Remove") subscribed.delete(change.queryId);
        else subscribed.set(change.queryId, { path: change.udfPath, args: change.args[0] ?? null });
      }

      const counts = new Map<string, number>();

      for (const { path } of subscribed.values()) counts.set(path, (counts.get(path) ?? 0) + 1);

      for (const [path, count] of counts) peaks.set(path, Math.max(peaks.get(path) ?? 0, count));

      const modifications = await Promise.all(
        message.modifications.map((change): Promise<Option.Option<Schema.Json>> =>
          change.type === "Remove"
            ? Promise.resolve(Option.some({ type: "QueryRemoved", queryId: change.queryId }))
            : answerQuery(change.queryId, { path: change.udfPath, args: change.args[0] ?? null }),
        ),
      );

      const answered = Option.all(modifications);

      if (Option.isNone(answered)) {
        socket.destroy();

        return;
      }

      transition({ querySet: message.newVersion, identity: version.identity }, answered.value);
    };

    const receive = (chunk: Buffer): void => {
      const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));

      pending = rest;

      for (const frame of frames) {
        if (frame.opcode === OPCODE_PING) writeFrame(socket, OPCODE_PONG, frame.payload);

        if (frame.opcode === OPCODE_CLOSE) {
          writeFrame(socket, OPCODE_CLOSE, frame.payload);
          socket.end();
          socket.off("data", receive);

          return;
        }

        if (frame.opcode !== OPCODE_TEXT) continue;
        const message = decodeSyncMessage(frame.payload.toString("utf8"));

        if (Option.isSome(message)) {
          queue = queue
            .then(() => handle(message.value))
            .catch(() => {
              socket.destroy();
            });
        }
      }
    };

    socket.on("data", receive);
    receive(head);
  };

  server.on("upgrade", (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    const key = incoming.headers["sec-websocket-key"];

    if (incoming.url?.endsWith("/sync") !== true || !Predicate.isString(key)) {
      socket.destroy();

      return;
    }

    const acceptKey = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "",
        "",
      ].join("\r\n"),
    );
    openSync(socket, head);
  });

  const closeSyncConnections = (): void => {
    for (const socket of syncSockets) socket.destroy();
  };

  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();

        resume(
          address === null || Predicate.isString(address)
            ? Effect.die(new Error("The fake Convex server is not on TCP"))
            : Effect.succeed(address.port),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        closeSyncConnections();
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

  return {
    url: `http://127.0.0.1:${String(port)}`,
    signInUrl: `http://127.0.0.1:${String(port)}${SIGN_IN_PATH}`,
    handle: (path, handler) =>
      Effect.sync(() => {
        handlers.set(path, handler);
      }),
    reply: (path, reply) =>
      Effect.sync(() => {
        handlers.set(path, () => Effect.succeed(reply));
      }),
    requests: Effect.sync(() => [...received]),
    requestsTo: (path) => Effect.sync(() => received.filter((request) => request.path === path)),
    acceptedTokens: Effect.sync(() => [...accepted]),
    refuseAcceptedTokens: Effect.sync(() => {
      for (const token of accepted) refused.add(token);
      closeSyncConnections();
    }),
    rejectAcceptedTokens: Effect.sync(() => {
      for (const token of accepted) refused.add(token);

      for (const sendAuthError of authErrorSenders) sendAuthError();
    }),
    rejectEveryToken: Effect.sync(() => {
      rejecting.every = true;
    }),
    peakSubscriptions: (path) => Effect.sync(() => peaks.get(path) ?? 0),
  };
});

import type { ConvexReactClientOptions } from "convex/react";
import { Option, Schema } from "effect";

import { mentionsWrongCredentials } from "./sign-in";

/** The Convex client's logger shape (the `logger` option without its `true`/`false` shorthands). */
type ConvexLogger = Exclude<NonNullable<ConvexReactClientOptions["logger"]>, boolean>;

/** Where log lines go; the browser console in the app. */
export type LogSink = Pick<Console, "log" | "warn" | "error">;

/** The Convex client logs every failed action as `[CONVEX A(<path>)] <server message>`. */
const SIGN_IN_ACTION = /^\[CONVEX A\(auth:signIn\)\] /;

const decodeLine = Schema.decodeUnknownOption(Schema.String);

/** A sign-in rejected for its email or password, which the sign-in screen already reports. */
const isWrongCredentials = (line: string): boolean =>
  SIGN_IN_ACTION.test(line) && mentionsWrongCredentials(line);

/**
 * Logs Convex client messages to `sink`, except a sign-in rejected for a wrong email or password
 * (ADS-109): the sign-in screen tells the user, so it isn't a fault. Every other failure logs,
 * including other `auth:signIn` failures such as a failed session refresh or a server fault.
 */
export const convexLogger = (sink: LogSink): ConvexLogger => ({
  logVerbose: () => undefined,
  log: (...args: ReadonlyArray<unknown>) => sink.log(...args),
  warn: (...args: ReadonlyArray<unknown>) => sink.warn(...args),
  error: (...args: ReadonlyArray<unknown>) => {
    if (Option.exists(decodeLine(args[0]), isWrongCredentials)) return;

    sink.error(...args);
  },
});

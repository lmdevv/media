/**
 * References to the public Convex functions clients call, typed from the command registry rather
 * than from the backend source, so clients never compile Convex server code.
 */
import type { CommandResultEncoded, MutationName, QueryName } from "@music/commands/registry";
import { makeFunctionReference } from "convex/server";
import type { Schema } from "effect";

/** Encoded command arguments. Every registry `args` schema encodes to a JSON object. */
type WireArgs = Schema.JsonObject;

/** `commands:read`: runs a query command. */
export const readCommand = makeFunctionReference<
  "query",
  { name: QueryName; args: WireArgs },
  CommandResultEncoded<QueryName>
>("commands:read");

/** `commands:run`: runs a mutation command. */
export const runCommand = makeFunctionReference<
  "mutation",
  { name: MutationName; args: WireArgs },
  CommandResultEncoded<MutationName>
>("commands:run");

/** `setup:status`: public first-run state. */
export const setupStatus = makeFunctionReference<
  "query",
  Record<string, never>,
  { hasUsers: boolean; hasLibraries: boolean }
>("setup:status");

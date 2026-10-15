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

/** Details an invite link reveals before sign-up. Times are milliseconds since the epoch. */
export interface InviteDetails {
  readonly email: string | null;
  readonly inviterName: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** What an invite code currently allows: `open` can sign up; the others explain why not. */
export type InviteLookup =
  | { readonly state: "invalid" }
  | ({ readonly state: "open" | "expired" | "used" } & InviteDetails);

/** `setup:invite`: public lookup of an invite code for the accept-invite screen. */
export const inviteLookup = makeFunctionReference<"query", { code: string }, InviteLookup>(
  "setup:invite",
);

/** Details a password reset link reveals before the new password is set. */
export interface PasswordResetDetails {
  readonly email: string;
  readonly name: string | null;
  readonly expiresAt: number;
}

/** What a reset token currently allows: `open` can set a password; the others explain why not. */
export type PasswordResetLookup =
  | { readonly state: "invalid" }
  | ({ readonly state: "open" | "expired" | "used" } & PasswordResetDetails);

/** `setup:passwordReset`: public lookup of a reset token for the reset-password screen. */
export const passwordResetLookup = makeFunctionReference<
  "query",
  { token: string },
  PasswordResetLookup
>("setup:passwordReset");

import type { GenericValidator, PropertyValidators } from "convex/values";

import type { Scope } from "./scopes.ts";

/** The domains: one folder each in the one Convex schema (ADR 0008). */
export const domains = ["core", "movies", "music"] as const;

/** A domain, the first part of every command name. */
export type Domain = (typeof domains)[number];

/**
 * How a command runs in Convex: a `query` reads and can be subscribed to, a `mutation` writes in
 * one transaction, and an `action` may call services outside Convex.
 */
export const commandKinds = ["query", "mutation", "action"] as const;

/** A command's kind: `query`, `mutation`, or `action`. */
export type CommandKind = (typeof commandKinds)[number];

/**
 * A command's name: its domain, its module path, and its function, such as `core.server.info`. The
 * Convex function is the same path with folders and a colon, `core/server:info`, and the clients
 * call it as `api.core.server.info`.
 */
export type CommandName = `${Domain}.${string}.${string}`;

/** One user, client, or agent action, declared once; the generator writes every entry point. */
export interface Command {
  readonly name: CommandName;
  readonly kind: CommandKind;
  /** Who may call it. The generator refuses a command without one. */
  readonly scope: Scope;
  /** One line for the skill reference, CLI help, and the command menu. */
  readonly summary: string;
  /** The arguments, written as Convex `args`. */
  readonly args: PropertyValidators;
  readonly result: GenericValidator;
}

type Definition = Omit<Command, "name" | "kind">;

/** Declares a query: it reads state, and clients can subscribe to it. */
export const query = (name: CommandName, definition: Definition): Command => ({
  ...definition,
  name,
  kind: "query",
});

/** Declares a mutation: it changes state in one transaction. */
export const mutation = (name: CommandName, definition: Definition): Command => ({
  ...definition,
  name,
  kind: "mutation",
});

/** Declares an action: it may call services outside Convex, such as a random source or the network. */
export const action = (name: CommandName, definition: Definition): Command => ({
  ...definition,
  name,
  kind: "action",
});

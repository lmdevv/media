/**
 * The builders for every function the server calls: job claims and reports today, scanner
 * callbacks later (ADR 0009 calls them server-facing). With no auth in the core yet they build
 * internal functions, which only the admin key can call. The unit that signs the server in
 * replaces these two definitions with public builders that refuse a caller without the
 * `media-service` scope; the functions then move from `internal.core.*` to `api.core.*`, and no
 * function body changes. That builder is the one public builder outside a command contract's
 * `register`, so the lint rule that bans `query` and `mutation` in `convex/` names this file as
 * its exception then.
 */
import { internalMutation, internalQuery } from "../../_generated/server";

export const serverQuery = internalQuery;

export const serverMutation = internalMutation;

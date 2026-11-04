/**
 * The builders for every function the server calls: job claims and reports today, scanner
 * callbacks later. This file is the p3-auth seam. With no auth in the core yet they build internal
 * functions, which only the admin key can call. p3-auth replaces these two definitions with public
 * builders that refuse a caller without the `media-service` scope; the functions then move from
 * `internal.core.*` to `api.core.*`, and no function body changes.
 */
import { internalMutation, internalQuery } from "../../_generated/server";

export const serverQuery = internalQuery;

export const serverMutation = internalMutation;

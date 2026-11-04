import { v } from "convex/values";

import { action, mutation, query } from "./command.ts";
import type { Command } from "./command.ts";
import { credentialScopes } from "./scopes.ts";

const credentialScope = v.union(...credentialScopes.map((scope) => v.literal(scope)));

/** The core's commands: the server itself, accounts, devices, and the other shared modules. */
export const core = [
  query("core.server.info", {
    summary: "Show this server's name and version",
    scope: "public",
    args: {},
    result: v.object({ name: v.string(), version: v.string() }),
  }),

  query("core.auth.sessions.current", {
    summary: "Show who is signed in, how, and with which scopes",
    scope: "signed-in",
    args: {},
    result: v.object({
      userId: v.id("users"),
      username: v.string(),
      sessionId: v.id("authSessions"),
      kind: v.union(v.literal("password"), v.literal("apiKey"), v.literal("deviceCode")),
      scopes: v.array(credentialScope),
    }),
  }),
  mutation("core.auth.sessions.end", {
    summary: "Sign out one of your sessions",
    scope: "account",
    args: { sessionId: v.id("authSessions") },
    result: v.null(),
  }),
  mutation("core.auth.sessions.endAll", {
    summary: "Sign out every password and device session you have, or every other one",
    scope: "account",
    args: { keepCurrent: v.boolean() },
    result: v.null(),
  }),

  action("core.auth.apiKeys.create", {
    summary: "Create an API key with some of this session's scopes and show its secret once",
    scope: "account",
    args: {
      name: v.string(),
      scopes: v.array(credentialScope),
      expiresInDays: v.optional(v.number()),
    },
    result: v.object({
      keyId: v.id("apiKeys"),
      key: v.string(),
      expiresAt: v.union(v.number(), v.null()),
    }),
  }),
  mutation("core.auth.apiKeys.revoke", {
    summary: "Revoke one of your API keys and sign out what it signed in",
    scope: "account",
    args: { keyId: v.id("apiKeys") },
    result: v.null(),
  }),
  mutation("core.auth.apiKeys.endAll", {
    summary: "Stop every API key you have made so far",
    scope: "account",
    args: {},
    result: v.null(),
  }),

  action("core.auth.deviceCodes.start", {
    summary: "Start a device sign-in and return its user code and secret device code",
    scope: "public",
    args: { clientName: v.string() },
    result: v.object({
      deviceCode: v.string(),
      userCode: v.string(),
      expiresAt: v.number(),
      intervalSeconds: v.number(),
    }),
  }),
  query("core.auth.deviceCodes.lookup", {
    summary: "Show the device waiting on a user code",
    scope: "account",
    args: { userCode: v.string() },
    result: v.object({
      clientName: v.string(),
      state: v.union(
        v.literal("pending"),
        v.literal("approved"),
        v.literal("denied"),
        v.literal("redeemed"),
        v.literal("expired"),
      ),
      expiresAt: v.number(),
    }),
  }),
  mutation("core.auth.deviceCodes.approve", {
    summary: "Sign a waiting device in as you, with some of this session's scopes",
    scope: "account",
    args: { userCode: v.string(), scopes: v.array(credentialScope) },
    result: v.null(),
  }),
  mutation("core.auth.deviceCodes.deny", {
    summary: "Refuse a waiting device",
    scope: "account",
    args: { userCode: v.string() },
    result: v.null(),
  }),
] as const satisfies ReadonlyArray<Command>;

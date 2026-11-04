import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import { restrictions } from "./access.ts";
import { action, mutation, query } from "./command.ts";
import type { Command } from "./command.ts";
import { assignableRoles, credentialScopes, roles } from "./scopes.ts";

const credentialScope = v.union(...credentialScopes.map((scope) => v.literal(scope)));

const role = v.union(...roles.map((name) => v.literal(name)));

const assignableRole = v.union(...assignableRoles.map((name) => v.literal(name)));

/** The core's commands: the server itself, accounts, devices, and the other shared modules. */
export const core = [
  query("core.server.info", {
    summary: "Show this server's name and version, and whether its owner has set it up",
    scope: "public",
    args: {},
    result: v.object({ name: v.string(), version: v.string(), hasOwner: v.boolean() }),
  }),

  query("core.auth.sessions.current", {
    summary: "Show who is signed in, how, and with which scopes",
    scope: "signed-in",
    args: {},
    result: v.object({
      userId: v.id("users"),
      username: v.string(),
      role,
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
    refusesKeys: true,
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
    refusesKeys: true,
    args: { userCode: v.string(), scopes: v.array(credentialScope) },
    result: v.null(),
  }),
  mutation("core.auth.deviceCodes.deny", {
    summary: "Refuse a waiting device",
    scope: "account",
    args: { userCode: v.string() },
    result: v.null(),
  }),

  action("core.accounts.invites.create", {
    summary:
      "Create an invite link code for someone new, who picks their own username and password",
    scope: "admin",
    refusesKeys: true,
    args: { role: v.optional(assignableRole), expiresInDays: v.optional(v.number()) },
    result: v.object({ inviteId: v.id("invites"), code: v.string(), expiresAt: v.number() }),
  }),
  query("core.accounts.invites.lookup", {
    summary: "Show what an invite code offers, or refuse it when it no longer works",
    scope: "public",
    args: { code: v.string() },
    result: v.object({ role: assignableRole, invitedBy: v.string(), expiresAt: v.number() }),
  }),
  query("core.accounts.invites.list", {
    summary: "List the invites that still work, latest to expire first",
    scope: "admin",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(
      v.object({
        inviteId: v.id("invites"),
        role: assignableRole,
        invitedBy: v.string(),
        expiresAt: v.number(),
      }),
    ),
  }),
  mutation("core.accounts.invites.revoke", {
    summary: "Revoke an invite so its code stops working",
    scope: "admin",
    args: { inviteId: v.id("invites") },
    result: v.null(),
  }),

  action("core.accounts.resetLinks.create", {
    summary: "Create a one-time link code that lets someone set a new password within a day",
    scope: "admin",
    refusesKeys: true,
    args: { userId: v.id("users") },
    result: v.object({ code: v.string(), expiresAt: v.number() }),
  }),
  query("core.accounts.resetLinks.lookup", {
    summary: "Show whose password a reset code sets, or refuse it when it no longer works",
    scope: "public",
    args: { code: v.string() },
    result: v.object({ username: v.string(), expiresAt: v.number() }),
  }),

  action("core.accounts.users.create", {
    summary: "Create a user with a username and password you choose for them",
    scope: "admin",
    refusesKeys: true,
    args: { username: v.string(), password: v.string(), role: v.optional(assignableRole) },
    result: v.object({ userId: v.id("users") }),
  }),
  query("core.accounts.users.list", {
    summary: "List every user with their role, by username",
    scope: "admin",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(
      v.object({ userId: v.id("users"), username: v.string(), role }),
    ),
  }),
  mutation("core.accounts.users.setRole", {
    summary: "Make someone else an admin or a member; the owner's role never changes this way",
    scope: "admin",
    refusesKeys: true,
    args: { userId: v.id("users"), role: assignableRole },
    result: v.null(),
  }),
  mutation("core.accounts.users.handOverOwnership", {
    summary: "Hand ownership of this server to another user and stay an admin, as the owner",
    scope: "admin",
    refusesKeys: true,
    args: { userId: v.id("users") },
    result: v.null(),
  }),

  mutation("core.permissions.groups.create", {
    summary: "Create a group of people to share with at once",
    scope: "admin",
    args: { name: v.string() },
    result: v.object({ groupId: v.id("groups") }),
  }),
  mutation("core.permissions.groups.rename", {
    summary: "Rename a group",
    scope: "admin",
    args: { groupId: v.id("groups"), name: v.string() },
    result: v.null(),
  }),
  mutation("core.permissions.groups.remove", {
    summary: "Delete a group, so what was shared with it no longer reaches its members",
    scope: "admin",
    args: { groupId: v.id("groups") },
    result: v.null(),
  }),
  query("core.permissions.groups.list", {
    summary: "List the groups by name",
    scope: "admin",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(v.object({ groupId: v.id("groups"), name: v.string() })),
  }),
  query("core.permissions.groups.members", {
    summary: "List the people in a group",
    scope: "admin",
    args: { groupId: v.id("groups"), paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(v.object({ userId: v.id("users"), username: v.string() })),
  }),
  mutation("core.permissions.groups.addMember", {
    summary: "Add someone to a group; what is shared with it reaches them on their next call",
    scope: "admin",
    args: { groupId: v.id("groups"), userId: v.id("users") },
    result: v.null(),
  }),
  mutation("core.permissions.groups.removeMember", {
    summary: "Take someone out of a group; what is shared with it stops reaching them at once",
    scope: "admin",
    args: { groupId: v.id("groups"), userId: v.id("users") },
    result: v.null(),
  }),

  query("core.restrictions.get", {
    summary: "Show a kid's limits on what they see, yours or as an admin someone else's",
    scope: "signed-in",
    args: { userId: v.id("users") },
    result: v.union(restrictions, v.null()),
  }),
  mutation("core.restrictions.set", {
    summary:
      "Limit what a member sees by movie rating, explicit music, and library, or lift the limits",
    scope: "admin",
    refusesKeys: true,
    args: { userId: v.id("users"), restrictions: v.union(restrictions, v.null()) },
    result: v.null(),
  }),

  mutation("core.accounts.me.rename", {
    summary: "Change your username; everything you own stays yours",
    scope: "account",
    refusesKeys: true,
    args: { username: v.string() },
    result: v.null(),
  }),
  action("core.accounts.me.changePassword", {
    summary: "Change your password and sign out your other password and device sessions",
    scope: "account",
    refusesKeys: true,
    args: { currentPassword: v.string(), newPassword: v.string() },
    result: v.null(),
  }),
] as const satisfies ReadonlyArray<Command>;

import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import { grantPrincipal, level, resourceRef, restrictions } from "./access.ts";
import { action, mutation, query } from "./command.ts";
import type { Command } from "./command.ts";
import { assignableRoles, contentDomains, credentialScopes, roles } from "./scopes.ts";

const credentialScope = v.union(...credentialScopes.map((scope) => v.literal(scope)));

const role = v.union(...roles.map((name) => v.literal(name)));

const assignableRole = v.union(...assignableRoles.map((name) => v.literal(name)));

const libraryKind = v.union(...contentDomains.map((domain) => v.literal(domain)));

const libraryRow = {
  libraryId: v.id("libraries"),
  name: v.string(),
  kind: libraryKind,
  level,
};

const jobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
);

const deviceMode = v.union(v.literal("personal"), v.literal("shared"));

const approvalIntent = v.union(v.literal("open"), v.literal("leave"));

/** Why a tile on a shared device is locked (ADR 0006). */
const lockReason = v.union(
  v.literal("admin-rule"),
  v.literal("kid-listed"),
  v.literal("kid-holds-device"),
);

/** Whose proof opens a locked tile: its own person, an adult vouching for a kid, or either. */
const opener = v.union(v.literal("self"), v.literal("adult"), v.literal("self-or-adult"));

const sharedTile = v.object({
  userId: v.id("users"),
  username: v.string(),
  kid: v.boolean(),
  /** The person's unlock code on this device: none set, ready, or off after 5 wrong tries. */
  code: v.union(v.literal("none"), v.literal("ready"), v.literal("off")),
  lock: v.union(
    v.object({ state: v.literal("open") }),
    v.object({ state: v.literal("locked"), because: v.array(lockReason), opensWith: opener }),
  ),
});

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
      kind: v.union(
        v.literal("password"),
        v.literal("apiKey"),
        v.literal("deviceCode"),
        v.literal("tile"),
      ),
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
    refusesKeys: true,
    args: { groupId: v.id("groups"), userId: v.id("users") },
    result: v.null(),
  }),
  mutation("core.permissions.groups.removeMember", {
    summary: "Take someone out of a group; what is shared with it stops reaching them at once",
    scope: "admin",
    args: { groupId: v.id("groups"), userId: v.id("users") },
    result: v.null(),
  }),

  mutation("core.libraries.create", {
    summary: "Create a library of movies or music from folders on the server and scan it",
    scope: "admin",
    refusesKeys: true,
    args: { name: v.string(), kind: libraryKind, folders: v.array(v.string()) },
    result: v.object({ libraryId: v.id("libraries"), scanJobId: v.id("jobs") }),
  }),
  query("core.libraries.list", {
    summary: "List the libraries shared with you",
    scope: "signed-in",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(v.object(libraryRow)),
  }),
  query("core.libraries.get", {
    summary:
      "Show a library, how many items it holds, its latest scan, and to its managers its folders",
    scope: "signed-in",
    args: { libraryId: v.id("libraries") },
    result: v.object({
      ...libraryRow,
      items: v.union(v.number(), v.null()),
      folders: v.union(v.array(v.string()), v.null()),
      scan: v.union(
        v.object({
          jobId: v.id("jobs"),
          status: jobStatus,
          done: v.union(v.number(), v.null()),
          total: v.union(v.number(), v.null()),
          error: v.union(v.string(), v.null()),
          finishedAt: v.union(v.number(), v.null()),
        }),
        v.null(),
      ),
    }),
  }),
  mutation("core.libraries.rename", {
    summary: "Rename a library you manage",
    scope: "signed-in",
    args: { libraryId: v.id("libraries"), name: v.string() },
    result: v.null(),
  }),
  mutation("core.libraries.setFolders", {
    summary:
      "Change the folders of a library you manage; what a removed folder held leaves the library",
    scope: "admin",
    refusesKeys: true,
    args: { libraryId: v.id("libraries"), folders: v.array(v.string()) },
    result: v.object({ scanJobId: v.union(v.id("jobs"), v.null()) }),
  }),
  mutation("core.libraries.scan", {
    summary: "Scan a library for new, changed, and missing files, or join the scan already queued",
    scope: "signed-in",
    args: { libraryId: v.id("libraries") },
    result: v.object({ jobId: v.id("jobs"), created: v.boolean() }),
  }),
  mutation("core.libraries.remove", {
    summary: "Delete a library you manage and everything it lists; the files on disk stay",
    scope: "signed-in",
    refusesKeys: true,
    args: { libraryId: v.id("libraries") },
    result: v.null(),
  }),

  mutation("core.permissions.grants.set", {
    summary: "Share something you manage with a person, a group, or everyone, at exactly one level",
    scope: "signed-in",
    refusesKeys: true,
    args: { resource: resourceRef, principal: grantPrincipal, level },
    result: v.null(),
  }),
  mutation("core.permissions.grants.remove", {
    summary: "Stop sharing something you manage with someone, or leave what was shared with you",
    scope: "signed-in",
    args: { resource: resourceRef, principal: grantPrincipal },
    result: v.null(),
  }),
  query("core.permissions.grants.list", {
    summary: "List who something you manage is shared with, and at which level",
    scope: "signed-in",
    args: { resource: resourceRef, paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(
      v.object({
        principal: v.union(
          v.object({ kind: v.literal("user"), userId: v.id("users"), username: v.string() }),
          v.object({ kind: v.literal("group"), groupId: v.id("groups"), name: v.string() }),
          v.object({ kind: v.literal("household") }),
        ),
        level,
      }),
    ),
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

  action("core.devices.registry.enroll", {
    summary:
      "Register this app as a personal device, or find it again by its device code, and sign this session in on it",
    scope: "account",
    refusesKeys: true,
    args: { name: v.string(), device: v.optional(v.string()) },
    result: v.object({ deviceId: v.id("devices"), device: v.string() }),
  }),
  query("core.devices.registry.list", {
    summary: "List every registered device and whether it is shared, newest first",
    scope: "admin",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(
      v.object({ deviceId: v.id("devices"), name: v.string(), mode: deviceMode }),
    ),
  }),
  mutation("core.devices.registry.setMode", {
    summary:
      "Make a device shared, so its picker lists everyone who opted in, or personal again; either way everyone on it is signed out",
    scope: "admin",
    refusesKeys: true,
    args: { deviceId: v.id("devices"), mode: deviceMode },
    result: v.null(),
  }),
  mutation("core.devices.registry.remove", {
    summary: "Forget a device and sign everyone on it out",
    scope: "admin",
    refusesKeys: true,
    args: { deviceId: v.id("devices") },
    result: v.null(),
  }),
  query("core.devices.picker.show", {
    summary:
      "Show a device's picker: who is signed in on it, or on a shared device who opted in, which tiles are locked, and its approval",
    scope: "public",
    args: { device: v.string() },
    result: v.union(
      v.object({
        deviceId: v.id("devices"),
        name: v.string(),
        mode: v.literal("personal"),
        tiles: v.array(v.object({ userId: v.id("users"), username: v.string() })),
      }),
      v.object({
        deviceId: v.id("devices"),
        name: v.string(),
        mode: v.literal("shared"),
        holder: v.union(v.id("users"), v.null()),
        tiles: v.array(sharedTile),
        approval: v.union(
          v.object({
            approvalId: v.id("tileApprovals"),
            intent: approvalIntent,
            userId: v.id("users"),
            state: v.union(
              v.literal("pending"),
              v.literal("approved"),
              v.literal("denied"),
              v.literal("redeemed"),
            ),
            expiresAt: v.number(),
          }),
          v.null(),
        ),
      }),
    ),
  }),
  mutation("core.devices.tiles.setListed", {
    summary:
      "Put yourself on every shared device's picker or take yourself off; an admin decides it for a kid",
    scope: "account",
    refusesKeys: true,
    args: { userId: v.id("users"), listed: v.boolean() },
    result: v.null(),
  }),
  mutation("core.devices.tiles.setLock", {
    summary:
      "Require someone's tile on shared devices to open with a proof, or stop; the lock a listed kid causes stays",
    scope: "admin",
    refusesKeys: true,
    args: { userId: v.id("users"), locked: v.boolean() },
    result: v.null(),
  }),
  action("core.devices.unlockCodes.set", {
    summary:
      "Set or clear your short unlock code, which opens your tile on shared-device lock screens and never signs in",
    scope: "account",
    refusesKeys: true,
    args: { code: v.union(v.string(), v.null()) },
    result: v.null(),
  }),
  mutation("core.devices.unlockCodes.reset", {
    summary: "Turn someone's unlock code back on for one shared device after 5 wrong tries",
    scope: "admin",
    refusesKeys: true,
    args: { deviceId: v.id("devices"), userId: v.id("users") },
    result: v.null(),
  }),
  mutation("core.devices.approvals.request", {
    summary:
      "From a shared device, ask someone signed in elsewhere to open their locked tile, or an adult to let a kid leave",
    scope: "public",
    args: {
      device: v.string(),
      ask: v.union(
        v.object({ intent: v.literal("open"), userId: v.id("users") }),
        v.object({ intent: v.literal("leave") }),
      ),
    },
    result: v.object({ approvalId: v.id("tileApprovals"), expiresAt: v.number() }),
  }),
  query("core.devices.approvals.pending", {
    summary: "List the shared-device approvals you can answer now",
    scope: "account",
    args: {},
    result: v.array(
      v.object({
        approvalId: v.id("tileApprovals"),
        intent: approvalIntent,
        deviceName: v.string(),
        userId: v.id("users"),
        username: v.string(),
        expiresAt: v.number(),
      }),
    ),
  }),
  mutation("core.devices.approvals.approve", {
    summary: "Approve opening your tile on a shared device, or as an adult let a kid leave theirs",
    scope: "account",
    refusesKeys: true,
    args: { approvalId: v.id("tileApprovals") },
    result: v.null(),
  }),
  mutation("core.devices.approvals.deny", {
    summary: "Refuse a shared-device approval",
    scope: "account",
    args: { approvalId: v.id("tileApprovals") },
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

import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import {
  domainItem,
  downloadItem,
  downloadResource,
  grantPrincipal,
  level,
  resourceRef,
  restrictions,
} from "./access.ts";
import { action, mutation, query } from "./command.ts";
import type { Command } from "./command.ts";
import { assignableRoles, contentDomains, credentialScopes, roles } from "./scopes.ts";
import { downloadQuality, settingFields } from "./settings.ts";

const credentialScope = v.union(...credentialScopes.map((scope) => v.literal(scope)));

const role = v.union(...roles.map((name) => v.literal(name)));

const assignableRole = v.union(...assignableRoles.map((name) => v.literal(name)));

const contentDomain = v.union(...contentDomains.map((domain) => v.literal(domain)));

const libraryRow = {
  libraryId: v.id("libraries"),
  name: v.string(),
  kind: contentDomain,
  level,
};

const jobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
);

/**
 * What asking a job to stop did: a queued job is canceled at once, a running one stops at its
 * worker's next call, and one that already finished stays as it ended.
 */
export const canceled = v.union(
  v.object({
    outcome: v.literal("finished"),
    status: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("canceled")),
  }),
  v.object({ outcome: v.literal("canceling") }),
  /** It was claimed again after the attempt named, so nothing changed; look again to cancel it. */
  v.object({ outcome: v.literal("movedOn") }),
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

/**
 * Where a device's picture and sound go: the device itself, or a Chromecast or AirPlay receiver it
 * drives, which Connect reaches through that device (ADR 0018). A receiver may have no name, as
 * Safari leaves some AirPlay receivers.
 */
const connectOutput = v.union(
  v.object({ kind: v.literal("local") }),
  v.object({ kind: v.literal("cast"), receiver: v.union(v.string(), v.null()) }),
  v.object({ kind: v.literal("airplay"), receiver: v.union(v.string(), v.null()) }),
);

const reportedPlayback = v.object({
  domain: contentDomain,
  playing: v.boolean(),
  positionMs: v.number(),
});

/** Playback in server time: `positionMs` held at `at`, and moves on while `playing`. */
const anchoredTransport = {
  playing: v.boolean(),
  positionMs: v.number(),
  at: v.number(),
};

const sharedTile = v.object({
  userId: v.id("users"),
  username: v.string(),
  displayName: v.union(v.string(), v.null()),
  kid: v.boolean(),
  /** The person's unlock code on this device: none set, ready, or off after 5 wrong tries. */
  code: v.union(v.literal("none"), v.literal("ready"), v.literal("off")),
  lock: v.union(
    v.object({ state: v.literal("open") }),
    v.object({ state: v.literal("locked"), because: v.array(lockReason), opensWith: opener }),
  ),
});

const settingsView = v.object({
  user: v.object(settingFields("user", "required")),
  device: v.union(v.object(settingFields("device", "required")), v.null()),
});

/**
 * Why a kept item may no longer play here: the access behind it ended, a kid's restrictions now
 * hide it, or its device became shared and keeps nothing.
 */
const expiredBecause = v.union(v.literal("access"), v.literal("restricted"), v.literal("device"));

/**
 * One item kept on this device, as the device should treat its copy: `available` to hold at
 * `revision`, `expired` to delete, `gone` to delete and remove.
 */
const downloadEntry = v.union(
  v.object({
    item: downloadItem,
    state: v.literal("available"),
    revision: v.string(),
    quality: downloadQuality,
    bytes: v.number(),
    label: v.string(),
  }),
  v.object({ item: downloadItem, state: v.literal("expired"), because: expiredBecause }),
  v.object({ item: downloadItem, state: v.literal("gone") }),
);

/** Who may join a group session: anyone with its link, anyone its host lets in, or no one new. */
const joinSetting = v.union(v.literal("open"), v.literal("approval"), v.literal("locked"));

/** A seat in a group session. Everyone who is not its host is a guest, whatever their role. */
const togetherRole = v.union(v.literal("host"), v.literal("guest"));

/**
 * A group session's shared clock. The position at server time `t` is `positionAtAnchorMs + (t -
 * anchorServerTime) * playbackRate` while playing, and `positionAtAnchorMs` while paused. Each
 * move bumps `revision`; a client applies only a higher one.
 */
const togetherClock = v.object({
  status: v.union(v.literal("playing"), v.literal("paused")),
  positionAtAnchorMs: v.number(),
  anchorServerTime: v.number(),
  playbackRate: v.number(),
  revision: v.number(),
});

const togetherSettings = { join: joinSetting, control: v.boolean(), add: v.boolean() };

/** An item as the caller sees it: null when they may not play it, such as a kid and an R movie. */
const shownItem = v.union(domainItem, v.null());

/** One move of the clock. A seek and a skip carry the revision the caller saw. */
const controlOp = v.union(
  v.object({ kind: v.literal("play") }),
  v.object({ kind: v.literal("pause") }),
  v.object({ kind: v.literal("rate"), playbackRate: v.number() }),
  v.object({ kind: v.literal("seek"), positionMs: v.number(), revision: v.number() }),
  v.object({ kind: v.literal("next"), revision: v.number() }),
);

/** What a share link names (ADR 0007): an item its maker can play, or a group session they host. */
const shareTarget = v.union(
  v.object({ kind: v.literal("item"), item: domainItem }),
  v.object({ kind: v.literal("session"), domain: contentDomain }),
);

/**
 * Whether a share link still opens: `open`, `revoked`, `expired`, or `dead` when guest links were
 * turned off since it was made or its maker lost the right to make it.
 */
const linkState = v.union(
  v.literal("open"),
  v.literal("revoked"),
  v.literal("expired"),
  v.literal("dead"),
);

/** The core's commands: the server itself, accounts, devices, and the other shared modules. */
export const core = [
  query("core.server.info", {
    summary: "Show this server's name and version, and whether its owner has set it up",
    scope: "public",
    args: {},
    result: v.object({ name: v.string(), version: v.string(), hasOwner: v.boolean() }),
  }),
  query("core.server.status", {
    summary:
      "Show what the media server last reported: its version, hardware acceleration, streams, and when",
    scope: "admin",
    args: {},
    result: v.union(
      v.null(),
      v.object({
        version: v.string(),
        hardwareAcceleration: v.union(v.literal("qsv"), v.literal("vaapi"), v.literal("none")),
        activeStreams: v.number(),
        runsAwaitingExit: v.number(),
        startedAt: v.number(),
        reportedAt: v.number(),
      }),
    ),
  }),
  query("core.server.backups.list", {
    summary: "List the server's database backups, newest first",
    scope: "admin",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(
      v.object({
        id: v.id("backups"),
        fileName: v.string(),
        sizeBytes: v.number(),
        trigger: v.union(v.literal("nightly"), v.literal("manual")),
        takenAt: v.number(),
      }),
    ),
  }),
  query("core.server.backups.active", {
    summary: "Show the backup queued or running now, if any",
    scope: "admin",
    args: {},
    result: v.union(
      v.null(),
      v.object({ jobId: v.id("jobs"), status: v.union(v.literal("queued"), v.literal("running")) }),
    ),
  }),
  mutation("core.server.backups.run", {
    summary: "Back up the server's database now, or join the backup already queued or running",
    scope: "admin",
    args: {},
    result: v.object({ jobId: v.id("jobs") }),
  }),

  query("core.auth.sessions.current", {
    summary: "Show who is signed in, how, with which scopes, and on which device in what order",
    scope: "signed-in",
    args: {},
    result: v.object({
      userId: v.id("users"),
      username: v.string(),
      /** The name the person goes by, or null to go by their username. */
      displayName: v.union(v.string(), v.null()),
      role,
      sessionId: v.id("authSessions"),
      kind: v.union(
        v.literal("password"),
        v.literal("apiKey"),
        v.literal("deviceCode"),
        v.literal("tile"),
        v.literal("guest"),
        v.literal("grant"),
      ),
      scopes: v.array(credentialScope),
      device: v.union(v.null(), v.object({ deviceId: v.id("devices"), joinSequence: v.number() })),
    }),
  }),
  query("core.auth.sessions.list", {
    summary:
      "List your signed-in browsers, apps, and devices, newest first, with the device each is on; API keys' sessions are left to the key list",
    scope: "account",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(
      v.object({
        sessionId: v.id("authSessions"),
        kind: v.union(
          v.literal("password"),
          v.literal("deviceCode"),
          v.literal("tile"),
          v.literal("grant"),
        ),
        /** What it calls itself: its device's name, or the name a device sign-in gave; null for none. */
        name: v.union(v.string(), v.null()),
        device: v.union(v.null(), v.object({ deviceId: v.id("devices"), name: v.string() })),
        scopes: v.array(credentialScope),
        signedInAt: v.number(),
        expiresAt: v.number(),
        /** The session this call came from. */
        current: v.boolean(),
      }),
    ),
  }),
  mutation("core.auth.sessions.end", {
    summary: "Sign out one of your sessions",
    scope: "account",
    args: { sessionId: v.id("authSessions") },
    result: v.null(),
  }),
  mutation("core.auth.sessions.revoke", {
    summary:
      "End the session a refresh token belongs to, deleting it and every refresh token it has; confirmed even when it had already ended",
    scope: "public",
    args: { refreshToken: v.string() },
    result: v.object({ confirmed: v.literal(true) }),
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
  query("core.auth.apiKeys.list", {
    summary:
      "List your API keys that still work or ran out, newest first, with their scopes and last use; never their secrets",
    scope: "account",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(
      v.object({
        keyId: v.id("apiKeys"),
        name: v.string(),
        scopes: v.array(credentialScope),
        createdAt: v.number(),
        expiresAt: v.union(v.number(), v.null()),
        /** When it last signed in, or null when it never has. */
        lastUsedAt: v.union(v.number(), v.null()),
      }),
    ),
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
      v.object({
        userId: v.id("users"),
        username: v.string(),
        displayName: v.union(v.string(), v.null()),
        role,
      }),
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
  query("core.permissions.groups.memberOf", {
    summary: "List the groups someone is in, at most 16, so their page shows what reaches them",
    scope: "admin",
    args: { userId: v.id("users"), paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(v.object({ groupId: v.id("groups"), name: v.string() })),
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
    args: { name: v.string(), kind: contentDomain, folders: v.array(v.string()) },
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
          /** What the scan is doing now, such as `probing`; null when it reported nothing. */
          message: v.union(v.string(), v.null()),
          /** When the attempt running now started; null unless it runs. */
          startedAt: v.union(v.number(), v.null()),
          /** Claims so far, the latest attempt's number; a cancel names the attempt it saw. */
          attempt: v.number(),
          /** True while a cancel waits for the running scan's worker to stop. */
          canceling: v.boolean(),
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
    summary:
      "Scan a library for new, changed, and missing files, or join the scan already queued; full reads every file again",
    scope: "signed-in",
    args: {
      libraryId: v.id("libraries"),
      /** `full` probes every file again, unchanged ones included; `incremental` when omitted. */
      mode: v.optional(v.union(v.literal("incremental"), v.literal("full"))),
    },
    result: v.object({ jobId: v.id("jobs"), created: v.boolean() }),
  }),
  mutation("core.libraries.cancelScan", {
    summary:
      "Stop a library's scan at the attempt you saw; a finished scan stays as it ended, and what a scan wrote stays",
    scope: "signed-in",
    args: {
      jobId: v.id("jobs"),
      /** The scan's `attempt` as `core.libraries.get` showed it; a later attempt answers movedOn. */
      attempt: v.number(),
    },
    result: canceled,
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
    result: v.object({ deviceId: v.id("devices"), device: v.string(), joinSequence: v.number() }),
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
        tiles: v.array(
          v.object({
            userId: v.id("users"),
            username: v.string(),
            displayName: v.union(v.string(), v.null()),
          }),
        ),
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
    refusesKeys: true,
    args: { approvalId: v.id("tileApprovals") },
    result: v.null(),
  }),
  action("core.devices.deviceGrants.issue", {
    summary:
      "Issue the grant this phone or tablet keeps for your other apps, or confirm the one it keeps, and show it; a grant it keeps for someone else is revoked, signing them out of its apps",
    scope: "account",
    refusesKeys: true,
    args: { name: v.string(), grant: v.optional(v.string()) },
    result: v.object({ grantId: v.id("deviceGrants"), grant: v.string() }),
  }),
  query("core.devices.deviceGrants.list", {
    summary:
      "List your device grants, newest first, with whether each still signs apps in and the apps signed in with it",
    scope: "account",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(
      v.object({
        grantId: v.id("deviceGrants"),
        name: v.string(),
        issuedAt: v.number(),
        signsIn: v.boolean(),
        devices: v.array(v.object({ deviceId: v.id("devices"), name: v.string() })),
      }),
    ),
  }),
  mutation("core.devices.deviceGrants.revoke", {
    summary: "Revoke one of your device grants and sign out every app it signed in",
    scope: "account",
    args: { grantId: v.id("deviceGrants") },
    result: v.null(),
  }),

  query("core.settings.get", {
    summary:
      "Show your settings: the ones that follow you to every device, and your own on this device",
    scope: "signed-in",
    args: {},
    result: settingsView,
  }),
  mutation("core.settings.set", {
    summary:
      "Change some of your settings; each follows you or stays on this device, as the settings table marks it",
    scope: "signed-in",
    args: settingFields("all", "optional"),
    result: settingsView,
  }),
  query("core.connect.targets.list", {
    summary:
      "List the online devices you can control with Connect, newest report first, with what each plays and where",
    scope: "signed-in",
    args: {},
    result: v.array(
      v.object({
        deviceId: v.id("devices"),
        name: v.string(),
        mode: deviceMode,
        output: connectOutput,
        playback: v.union(
          v.null(),
          v.object({ domain: contentDomain, ...anchoredTransport, pending: v.boolean() }),
        ),
        reportedAt: v.number(),
      }),
    ),
  }),
  mutation("core.connect.targets.control", {
    summary:
      "Pause, play, or seek a device you can control; it follows within about a quarter second",
    scope: "signed-in",
    args: {
      deviceId: v.id("devices"),
      playing: v.optional(v.boolean()),
      positionMs: v.optional(v.number()),
    },
    result: v.object({ revision: v.number() }),
  }),
  mutation("core.connect.player.report", {
    summary:
      "Report what this device plays, where it plays it, and the newest request it has applied",
    scope: "signed-in",
    args: {
      output: connectOutput,
      playback: v.union(reportedPlayback, v.null()),
      applied: v.number(),
    },
    result: v.object({ reportedAt: v.number() }),
  }),
  query("core.connect.player.requested", {
    summary: "Show the playback another device asked of this one that it has not applied yet",
    scope: "signed-in",
    args: {},
    result: v.union(v.null(), v.object({ revision: v.number(), ...anchoredTransport })),
  }),

  mutation("core.downloads.add", {
    summary:
      "Keep an item on this device for offline play at its download quality, within the device's download limit",
    scope: "signed-in",
    args: { item: downloadItem },
    result: v.null(),
  }),
  query("core.downloads.list", {
    summary:
      "List what you keep on this device, newest first, and whether each item can still play here",
    scope: "signed-in",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(downloadEntry),
  }),
  mutation("core.downloads.fetch", {
    summary:
      "Get a 15-minute download ticket for the current version of an item you keep on this device",
    scope: "signed-in",
    args: { item: downloadItem },
    result: v.union(
      v.object({
        state: v.literal("available"),
        revision: v.string(),
        quality: downloadQuality,
        bytes: v.number(),
        resource: downloadResource,
        ticket: v.string(),
        expiresAt: v.number(),
      }),
      v.object({ state: v.literal("expired"), because: expiredBecause }),
      v.object({ state: v.literal("gone") }),
    ),
  }),
  mutation("core.downloads.remove", {
    summary: "Stop keeping an item on this device and free the space it takes",
    scope: "signed-in",
    args: { item: downloadItem },
    result: v.null(),
  }),
  query("core.downloads.usage", {
    summary: "Show how much of this device's download limit everyone on it uses",
    scope: "signed-in",
    args: {},
    result: v.object({
      bytes: v.number(),
      items: v.number(),
      capBytes: v.number(),
      capItems: v.number(),
    }),
  }),
  mutation("core.downloads.setCap", {
    summary:
      "Set how many bytes of downloads a device may keep for everyone on it, or null for the default",
    scope: "admin",
    args: { deviceId: v.id("devices"), bytes: v.union(v.number(), v.null()) },
    result: v.null(),
  }),

  mutation("core.accounts.me.rename", {
    summary: "Change your username; everything you own stays yours",
    scope: "account",
    refusesKeys: true,
    args: { username: v.string() },
    result: v.null(),
  }),
  mutation("core.accounts.me.setDisplayName", {
    summary: "Set the name you go by in greetings and lists, or clear it to go by your username",
    scope: "account",
    refusesKeys: true,
    args: { displayName: v.union(v.string(), v.null()) },
    result: v.null(),
  }),
  action("core.accounts.me.changePassword", {
    summary: "Change your password and sign out your other password and device sessions",
    scope: "account",
    refusesKeys: true,
    args: { currentPassword: v.string(), newPassword: v.string() },
    result: v.null(),
  }),
  action("core.together.create", {
    summary:
      "Start a group session on something you can play, leaving any session you are a guest in, and get its join link",
    scope: "signed-in",
    refusesKeys: true,
    args: {
      item: domainItem,
      join: v.optional(joinSetting),
      control: v.optional(v.boolean()),
      add: v.optional(v.boolean()),
    },
    result: v.object({ sessionId: v.id("togetherSessions"), link: v.string() }),
  }),
  mutation("core.together.join", {
    summary:
      "Join the group session a link opens, or wait for its host to let you in; leaves your other session in this domain",
    scope: "signed-in",
    args: { domain: contentDomain, link: v.string() },
    result: v.object({ state: v.union(v.literal("joined"), v.literal("pending")) }),
  }),
  query("core.together.get", {
    summary:
      "Show your group session in a domain: its clock, item, members, settings, link, and what you may do",
    scope: "signed-in",
    args: { domain: contentDomain },
    result: v.union(
      v.null(),
      v.object({
        state: v.literal("pending"),
        sessionId: v.id("togetherSessions"),
        host: v.string(),
      }),
      v.object({
        state: v.literal("ended"),
        sessionId: v.id("togetherSessions"),
        reason: v.union(v.literal("host-left"), v.literal("abandoned")),
      }),
      v.object({
        state: v.literal("joined"),
        sessionId: v.id("togetherSessions"),
        host: v.string(),
        role: togetherRole,
        link: v.string(),
        settings: v.object(togetherSettings),
        may: v.object({ control: v.boolean(), add: v.boolean(), manage: v.boolean() }),
        clock: togetherClock,
        item: shownItem,
        members: v.array(
          v.object({
            userId: v.id("users"),
            username: v.string(),
            role: togetherRole,
            present: v.boolean(),
            /** A guest a share link let in, named by what they typed, not someone in the household. */
            linkGuest: v.boolean(),
          }),
        ),
        /** Who waits to be let in; only the host sees them. */
        pending: v.union(
          v.array(v.object({ userId: v.id("users"), username: v.string(), present: v.boolean() })),
          v.null(),
        ),
      }),
    ),
  }),
  mutation("core.together.heartbeat", {
    summary: "Keep yourself present in your group session in a domain and read the server clock",
    scope: "signed-in",
    args: { domain: contentDomain },
    result: v.object({ serverTime: v.number() }),
  }),
  mutation("core.together.control", {
    summary:
      "Play, pause, seek, change the speed of, or skip to the next item in your group session",
    scope: "signed-in",
    args: { domain: contentDomain, op: controlOp },
    result: togetherClock,
  }),
  query("core.together.queue", {
    summary: "List what plays next in your group session in a domain",
    scope: "signed-in",
    args: { domain: contentDomain, paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(
      v.object({
        entryId: v.id("togetherEntries"),
        item: shownItem,
        addedBy: v.union(v.string(), v.null()),
        removable: v.boolean(),
      }),
    ),
  }),
  mutation("core.together.add", {
    summary: "Queue something you can play in your group session, next or at the end",
    scope: "signed-in",
    args: { item: domainItem, at: v.optional(v.union(v.literal("next"), v.literal("end"))) },
    result: v.object({ entryId: v.id("togetherEntries") }),
  }),
  mutation("core.together.remove", {
    summary:
      "Take an entry out of your group session's queue: any as its host, your own as a guest",
    scope: "signed-in",
    args: { domain: contentDomain, entryId: v.id("togetherEntries") },
    result: v.null(),
  }),
  mutation("core.together.admit", {
    summary: "Let someone waiting to join your group session in, as its host",
    scope: "signed-in",
    args: { domain: contentDomain, userId: v.id("users") },
    result: v.null(),
  }),
  action("core.together.block", {
    summary:
      "Remove someone from your group session or turn their request away, as its host; its join link no longer lets them in",
    scope: "signed-in",
    args: { domain: contentDomain, userId: v.id("users") },
    result: v.null(),
  }),
  mutation("core.together.configure", {
    summary:
      "Set who may join your group session and whether its guests may control playback and add items",
    scope: "signed-in",
    args: { domain: contentDomain, ...togetherSettings },
    result: v.null(),
  }),
  mutation("core.together.leave", {
    summary: "Leave your group session in a domain; when you host it, it ends for everyone",
    scope: "signed-in",
    args: { domain: contentDomain },
    result: v.null(),
  }),
  query("core.guests.status", {
    summary: "Show whether guest links are on, the address they use, and whether you may make them",
    scope: "account",
    args: {},
    result: v.object({
      enabled: v.boolean(),
      address: v.union(v.string(), v.null()),
      mayShare: v.boolean(),
    }),
  }),
  mutation("core.guests.configure", {
    summary:
      "Turn guest links on or off and set the address they use; turning them off ends every link made so far",
    scope: "admin",
    refusesKeys: true,
    args: { enabled: v.boolean(), address: v.union(v.string(), v.null()) },
    result: v.null(),
  }),
  mutation("core.guests.allow", {
    summary:
      "Let a member make guest links, or stop them; stopping signs them out and ends the links they made",
    scope: "admin",
    refusesKeys: true,
    args: { userId: v.id("users"), allowed: v.boolean() },
    result: v.null(),
  }),
  query("core.guests.current", {
    summary: "Show a guest what their share link names, who shared it, and when it stops working",
    scope: "signed-in",
    args: {},
    result: v.union(
      v.null(),
      v.object({
        name: v.string(),
        sharedBy: v.string(),
        target: shareTarget,
        expiresAt: v.number(),
      }),
    ),
  }),
  action("core.guests.links.create", {
    summary:
      "Make a guest link to something you can play or to the group session you host, shown only this once",
    scope: "account",
    refusesKeys: true,
    args: { target: shareTarget, expiresInDays: v.optional(v.number()) },
    result: v.object({ linkId: v.id("shareLinks"), url: v.string(), expiresAt: v.number() }),
  }),
  query("core.guests.links.list", {
    summary: "List the guest links you made, or as an admin everyone's, newest first",
    scope: "account",
    args: {
      whose: v.union(v.literal("mine"), v.literal("everyone")),
      paginationOpts: paginationOptsValidator,
    },
    result: paginationResultValidator(
      v.object({
        linkId: v.id("shareLinks"),
        madeBy: v.string(),
        kind: v.union(v.literal("item"), v.literal("session")),
        domain: contentDomain,
        /** What it names; only its maker sees this, so an admin never sees someone's content. */
        target: v.union(shareTarget, v.null()),
        state: linkState,
        madeAt: v.number(),
        expiresAt: v.number(),
      }),
    ),
  }),
  query("core.guests.links.activity", {
    summary: "List who opened a guest link and when, as its maker or an admin",
    scope: "account",
    args: { linkId: v.id("shareLinks"), paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(
      v.object({ guestId: v.id("users"), name: v.string(), openedAt: v.number() }),
    ),
  }),
  mutation("core.guests.links.revoke", {
    summary:
      "Revoke a guest link, yours or as an admin anyone's; its guests are signed out at once",
    scope: "account",
    args: { linkId: v.id("shareLinks") },
    result: v.null(),
  }),
] as const satisfies ReadonlyArray<Command>;

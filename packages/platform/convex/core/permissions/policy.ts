import { levels } from "../../../commands/access";
import type {
  Level,
  LibraryId,
  ResourceType,
  Restrictions,
  resourceTypes,
} from "../../../commands/access";
import { domainScopes, roleScopes } from "../../../commands/scopes";
import type { ContentDomain, ContentVerb, CredentialScope, Role } from "../../../commands/scopes";
import type { Doc, Id } from "../../_generated/dataModel";

/** A user row that is a person: someone with a role who signs in with a password. */
export type PersonDoc = Extract<Doc<"users">, { readonly kind: "person" }>;

/**
 * Who acts. A person has a role, the scopes their credential holds now, and their restrictions. A
 * service, such as the media server, has no role and no restrictions.
 */
export type Principal =
  | {
      readonly kind: "person";
      readonly userId: Id<"users">;
      readonly role: Role;
      readonly scopes: ReadonlyArray<CredentialScope>;
      readonly restrictions: Restrictions | null;
    }
  | {
      readonly kind: "service";
      readonly userId: Id<"users">;
      readonly scopes: ReadonlyArray<CredentialScope>;
    };

/** A movie's rating as the minimum viewer age it needs (G 0, PG 7, PG-13 13, R 17, NC-17 18). */
export type Rating =
  | { readonly kind: "unrated" }
  | { readonly kind: "rated"; readonly age: number };

/** The facts restrictions read about one thing, by its domain. */
export type ContentFacts =
  | { readonly domain: "movies"; readonly rating: Rating }
  | { readonly domain: "music"; readonly explicit: boolean };

/**
 * Where a thing sits, which decides what a kid's restrictions do to it. Each variant states both
 * choices, so no resource fails open by leaving a field empty.
 *
 * - `library`: a library itself. The allowed-libraries list names it. It has no rating; each of
 *   its items is checked on its own.
 * - `item`: a thing in exactly one library, such as a title or a track. Both checks apply, and an
 *   unrated movie is the fact `unrated`, which `hideUnrated` hides.
 * - `unplaced`: a thing in no one library, such as a playlist. Its type says what a set
 *   allowed-libraries list does to it, `hides` or `allows` (its contents are then checked one by
 *   one), and whether it carries facts of its own or is a `container`.
 */
export type Placement =
  | { readonly in: "library"; readonly library: LibraryId }
  | { readonly in: "item"; readonly library: LibraryId; readonly facts: ContentFacts }
  | {
      readonly in: "unplaced";
      readonly libraryList: "hides" | "allows";
      readonly facts: ContentFacts | "container";
    };

/** A thing in a content domain, with what the loader read about it for this principal. */
export interface ContentResource {
  readonly on: "content";
  readonly domain: ContentDomain;
  /** The strongest level any grant gives the principal: their own, a group's, or the household's. */
  readonly level: Level | null;
  readonly placement: Placement;
}

export type TableOf<T extends ResourceType> = (typeof resourceTypes)[T]["table"];

export interface ResourceRef<T extends ResourceType> {
  readonly type: T;
  readonly id: Id<TableOf<T>>;
}

type Placed = Pick<ContentResource, "domain" | "placement">;

/** A movie's minimum viewer age as a rating, unrated when it has none. */
export const ratingOf = (age: number | null): Rating =>
  age === null ? { kind: "unrated" } : { kind: "rated", age };

type Placements = { readonly [T in ResourceType]: (doc: Doc<TableOf<T>>) => Placed };

const placements: Placements = {
  library: (library) => ({
    domain: library.kind,
    placement: { in: "library", library: library._id },
  }),
};

/** A row of a resource type as `can` sees it, at the level the principal's grants give them. */
export const resourceOf = <T extends ResourceType>(
  type: T,
  doc: Doc<TableOf<T>>,
  level: Level | null,
): ContentResource => ({ on: "content", level, ...placements[type](doc) });

/** An item of `library` with `facts`, as `can` sees it at the level the library's grants give. */
export const itemOf = (
  library: Doc<"libraries">,
  level: Level | null,
  facts: ContentFacts,
): ContentResource => ({
  on: "content",
  domain: library.kind,
  level,
  placement: { in: "item", library: library._id, facts },
});

/** The account an account action changes. */
export type AccountTarget =
  | {
      readonly kind: "person";
      readonly userId: Id<"users">;
      readonly role: Role;
      readonly restricted: boolean;
    }
  | { readonly kind: "service"; readonly userId: Id<"users"> };

/** Someone's account, as an account action's target. */
export interface AccountResource {
  readonly on: "account";
  readonly target: AccountTarget;
}

/** The server as a whole, the target of a server-wide action. */
export interface ServerResource {
  readonly on: "server";
}

/** The server, for `can(principal, "invite", SERVER)`. */
export const SERVER: ServerResource = { on: "server" };

/** Why `can` refused. */
export type Because =
  | "service"
  | "no-grant"
  | "restricted"
  | "scope"
  | "level"
  | "actor"
  | "self"
  | "service-target"
  | "target-role"
  | "restricted-target"
  | "unrestricted-target"
  | "unlisted"
  | "locked"
  | "kid-lock"
  | "not-yours"
  | "not-adult"
  | "guest"
  | "not-signed-in-here";

/**
 * An access decision. `hidden` answers as if the thing did not exist, so a private thing stays
 * private from everyone, admins included; `forbidden` refuses something the principal can see.
 */
export type Decision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly refusal: "hidden" | "forbidden";
      readonly because: Because;
    };

/** What can be done to a thing in a content domain. `manage` shares, renames, and deletes it. */
export const contentActions = ["view", "play", "edit", "manage"] as const;

/** What can be done to someone's account. */
export const accountActions = [
  "promote",
  "demote",
  "resetPassword",
  "restrict",
  "viewRestrictions",
  "joinGroup",
  "handOverOwnership",
  "listOnSharedDevices",
  "resetUnlockCode",
] as const;

/** What can be done to the server as a whole. */
export const serverActions = ["invite", "manageGroups", "manageFolders", "manageDevices"] as const;

export type ContentAction = (typeof contentActions)[number];

export type AccountAction = (typeof accountActions)[number];

export type ServerAction = (typeof serverActions)[number];

interface ContentRule {
  readonly verb: ContentVerb;
  readonly level: Level;
}

interface AccountRule {
  readonly scope: CredentialScope;
  /** The roles that may act, when narrower than every role holding the scope. */
  readonly actors?: ReadonlyArray<Role>;
  /**
   * `refuse`: never on oneself. `allow`: oneself like anyone. `always`: oneself needs no scope.
   * `adult`: oneself needs only `account` and no restrictions, so a kid needs an admin.
   */
  readonly self: "refuse" | "allow" | "always" | "adult";
  readonly targets: ReadonlyArray<Role>;
  /** Whether someone else the action reaches may carry restrictions, must not, or must. */
  readonly restricted: "any" | "never" | "only";
}

interface ServerRule {
  readonly scope: CredentialScope;
}

type ContentRules = { readonly [A in ContentAction]: ContentRule };

type AccountRules = { readonly [A in AccountAction]: AccountRule };

type ServerRules = { readonly [A in ServerAction]: ServerRule };

const contentRules: ContentRules = {
  view: { verb: "read", level: "view" },
  play: { verb: "play", level: "view" },
  edit: { verb: "edit", level: "edit" },
  manage: { verb: "edit", level: "manage" },
};

export interface ContentNeeds {
  readonly scope: CredentialScope;
  readonly level: Level;
}

/** The scope and the grant level a content action needs on a thing in `domain`. */
export const contentNeeds = (action: ContentAction, domain: ContentDomain): ContentNeeds => ({
  scope: `${domain}:${contentRules[action].verb}`,
  level: contentRules[action].level,
});

const PEOPLE: ReadonlyArray<Role> = ["admin", "member"];

const HOUSEHOLD: ReadonlyArray<Role> = ["owner", "admin", "member"];

const accountRules: AccountRules = {
  promote: { scope: "admin", self: "refuse", targets: PEOPLE, restricted: "never" },
  demote: { scope: "admin", self: "refuse", targets: PEOPLE, restricted: "any" },
  resetPassword: { scope: "admin", self: "refuse", targets: PEOPLE, restricted: "any" },
  restrict: { scope: "admin", self: "refuse", targets: ["member"], restricted: "any" },
  viewRestrictions: { scope: "admin", self: "always", targets: HOUSEHOLD, restricted: "any" },
  joinGroup: { scope: "admin", self: "allow", targets: HOUSEHOLD, restricted: "any" },
  handOverOwnership: {
    scope: "admin",
    actors: ["owner"],
    self: "refuse",
    targets: PEOPLE,
    restricted: "never",
  },
  listOnSharedDevices: { scope: "admin", self: "adult", targets: ["member"], restricted: "only" },
  resetUnlockCode: { scope: "admin", self: "allow", targets: HOUSEHOLD, restricted: "any" },
};

const serverRules: ServerRules = {
  invite: { scope: "admin" },
  manageGroups: { scope: "admin" },
  manageFolders: { scope: "admin" },
  manageDevices: { scope: "admin" },
};

const ALLOWED: Decision = { allowed: true };

const hidden = (because: Because): Decision => ({ allowed: false, refusal: "hidden", because });

const forbidden = (because: Because): Decision => ({
  allowed: false,
  refusal: "forbidden",
  because,
});

const rank = (level: Level): number => levels.indexOf(level);

const outsideList = (limits: Restrictions, library: LibraryId): boolean =>
  limits.libraries !== null && !limits.libraries.includes(library);

const ratingHides = (limits: Restrictions, facts: ContentFacts): boolean => {
  if (facts.domain === "music") return facts.explicit && limits.hideExplicitMusic;

  return facts.rating.kind === "unrated"
    ? limits.hideUnrated
    : limits.maxMovieAge !== null && facts.rating.age > limits.maxMovieAge;
};

const hiddenBy = (limits: Restrictions, placement: Placement): boolean => {
  if (placement.in === "library") return outsideList(limits, placement.library);

  if (placement.in === "item") {
    return outsideList(limits, placement.library) || ratingHides(limits, placement.facts);
  }

  return (
    (limits.libraries !== null && placement.libraryList === "hides") ||
    (placement.facts !== "container" && ratingHides(limits, placement.facts))
  );
};

const decideContent = (
  principal: Principal,
  action: ContentAction,
  resource: ContentResource,
): Decision => {
  const needs = contentNeeds(action, resource.domain);

  if (principal.kind === "service") return hidden("service");

  if (resource.level === null) return hidden("no-grant");

  if (principal.restrictions !== null && hiddenBy(principal.restrictions, resource.placement)) {
    return hidden("restricted");
  }

  if (!principal.scopes.includes(needs.scope)) return forbidden("scope");

  return rank(resource.level) < rank(needs.level) ? forbidden("level") : ALLOWED;
};

const actsAsAdult = (principal: Principal, target: AccountTarget): boolean =>
  target.kind === "person" && !target.restricted && principal.scopes.includes("account");

const restrictionRefusal = (rule: AccountRule, restricted: boolean): Decision => {
  if (rule.restricted === "never" && restricted) return forbidden("restricted-target");

  return rule.restricted === "only" && !restricted ? forbidden("unrestricted-target") : ALLOWED;
};

const decideAccount = (
  principal: Principal,
  rule: AccountRule,
  { target }: AccountResource,
): Decision => {
  const self = principal.userId === target.userId;

  if (self && rule.self === "always" && target.kind === "person") return ALLOWED;

  if (self && rule.self === "adult" && actsAsAdult(principal, target)) return ALLOWED;

  if (!principal.scopes.includes(rule.scope)) return forbidden("scope");

  if (
    principal.kind === "service" ||
    (rule.actors !== undefined && !rule.actors.includes(principal.role))
  ) {
    return forbidden("actor");
  }

  if (self && rule.self === "refuse") return forbidden("self");

  if (target.kind === "service") return forbidden("service-target");

  if (!rule.targets.includes(target.role)) return forbidden("target-role");

  return restrictionRefusal(rule, target.restricted);
};

const decideServer = (principal: Principal, rule: ServerRule): Decision =>
  principal.kind === "person" && principal.scopes.includes(rule.scope)
    ? ALLOWED
    : forbidden("scope");

/** Someone who proved themselves on a shared device's lock screen or answers its approval. */
export interface Prover {
  readonly userId: Id<"users">;
  readonly role: Role;
  readonly kid: boolean;
  /** Listed on shared devices' pickers. */
  readonly listed: boolean;
}

/** A person's row as a prover. */
export const proverOf = (person: PersonDoc): Prover => ({
  userId: person._id,
  role: person.role,
  kid: restrictionsOf(person) !== null,
  listed: person.sharedDevices === true,
});

const vouches = (prover: Prover): boolean =>
  prover.role !== "guest" &&
  !prover.kid &&
  (prover.listed || prover.role === "owner" || prover.role === "admin");

/** What can be done to a person's tile on shared devices. */
export const tileActions = ["open", "lock", "unlock"] as const;

export type TileAction = (typeof tileActions)[number];

/** A person's tile on a shared device, with the facts its locks read (ADR 0006). */
export interface TileResource {
  readonly on: "tile";
  /** The tile's person, and whether an admin requires their tile to lock. */
  readonly person: Prover & { readonly lockRequired: boolean };
  /** Someone the shared devices list is a kid. */
  readonly kidListed: boolean;
  /** The kid holding this device since their tile opened, or null. */
  readonly holder: Id<"users"> | null;
  /** Who proved themselves for this open, or null for none. */
  readonly proof: Prover | null;
}

/** Why a tile locks, in the order a lock screen names them. */
export const lockReasons = ["admin-rule", "kid-listed", "kid-holds-device"] as const;

export type LockReason = (typeof lockReasons)[number];

/** Whose proof lifts a lock: the tile's own person, an adult vouching for a kid, or either. */
export type Opener = "self" | "adult" | "self-or-adult";

interface LockRule {
  readonly applies: (tile: TileResource) => boolean;
  readonly opensWith: Opener;
}

type LockRules = { readonly [R in LockReason]: LockRule };

const lockRules: LockRules = {
  "admin-rule": { applies: (tile) => tile.person.lockRequired, opensWith: "self-or-adult" },
  "kid-listed": { applies: (tile) => tile.kidListed && !tile.person.kid, opensWith: "self" },
  "kid-holds-device": {
    applies: (tile) => tile.holder !== null && tile.holder !== tile.person.userId,
    opensWith: "adult",
  },
};

/** A tile's lock as its lock screen shows it. */
export type Lock =
  | { readonly state: "open" }
  | {
      readonly state: "locked";
      readonly because: ReadonlyArray<LockReason>;
      readonly opensWith: Opener;
    };

const accepts = (opener: Opener, prover: Prover, person: Prover): boolean => {
  const self = prover.userId === person.userId;
  const adult = vouches(prover) && (person.kid || self);

  if (opener === "self") return self;

  return opener === "adult" ? adult : self || adult;
};

/** The lock on a tile, from its facts alone; the proof does not change it. */
export const lockOf = (tile: TileResource): Lock => {
  const because = lockReasons.filter((reason) => lockRules[reason].applies(tile));

  if (because.length === 0) return { state: "open" };

  const bySelf = because.every((reason) =>
    accepts(lockRules[reason].opensWith, tile.person, tile.person),
  );

  const byAdult =
    tile.person.kid && because.every((reason) => lockRules[reason].opensWith !== "self");

  if (bySelf && byAdult) return { state: "locked", because, opensWith: "self-or-adult" };

  return { state: "locked", because, opensWith: bySelf ? "self" : "adult" };
};

type TileRule =
  | { readonly actor: "person" }
  | { readonly actor: "admin"; readonly keeps: ReadonlyArray<LockReason> };

type TileRules = { readonly [A in TileAction]: TileRule };

const tileRules: TileRules = {
  open: { actor: "person" },
  lock: { actor: "admin", keeps: [] },
  unlock: { actor: "admin", keeps: ["kid-listed"] },
};

const openTile = (principal: Principal, tile: TileResource): Decision => {
  if (principal.userId !== tile.person.userId) return forbidden("actor");

  if (!tile.person.listed || tile.person.role === "guest") return hidden("unlisted");

  const lock = lockOf(tile);
  const { proof } = tile;

  if (lock.state === "open") return ALLOWED;

  return proof !== null &&
    lock.because.every((reason) => accepts(lockRules[reason].opensWith, proof, tile.person))
    ? ALLOWED
    : forbidden("locked");
};

const decideTile = (principal: Principal, rule: TileRule, tile: TileResource): Decision => {
  if (principal.kind === "service") return hidden("service");

  if (rule.actor === "person") return openTile(principal, tile);

  if (!principal.scopes.includes("admin")) return forbidden("scope");

  if (tile.person.role === "guest") return forbidden("target-role");

  return rule.keeps.some((reason) => lockRules[reason].applies(tile))
    ? forbidden("kid-lock")
    : ALLOWED;
};

/** What can be done to an approval a shared device asked for. */
export const approvalActions = ["answer"] as const;

export type ApprovalAction = (typeof approvalActions)[number];

/** `open`: open a person's locked tile. `leave`: let the kid who holds a device leave it. */
export type ApprovalIntent = "open" | "leave";

/** An approval a shared device asked for, as `can` sees it for the person answering. */
export interface ApprovalResource {
  readonly on: "approval";
  readonly intent: ApprovalIntent;
  /** `open`: whose tile. `leave`: the kid who holds the device. */
  readonly userId: Id<"users">;
  /** The principal is listed on shared devices. */
  readonly answererListed: boolean;
}

type ApprovalRules = { readonly [I in ApprovalIntent]: "self" | "adult" };

const approvalRules: ApprovalRules = {
  open: "self",
  leave: "adult",
};

const decideApproval = (principal: Principal, approval: ApprovalResource): Decision => {
  if (principal.kind === "service") return hidden("service");

  if (!principal.scopes.includes("account")) return forbidden("scope");

  if (approvalRules[approval.intent] === "self") {
    return principal.userId === approval.userId ? ALLOWED : hidden("not-yours");
  }

  const answerer: Prover = {
    userId: principal.userId,
    role: principal.role,
    kid: principal.restrictions !== null,
    listed: approval.answererListed,
  };

  return vouches(answerer) ? ALLOWED : forbidden("not-adult");
};

/** What can be done to a registered device. Connect adds its own rows. */
export const deviceActions = ["control"] as const;

export type DeviceAction = (typeof deviceActions)[number];

/** How the principal relates to a device: signed in on a personal one, listed on a shared one. */
export type DeviceRelation =
  | { readonly mode: "personal"; readonly signedInHere: boolean }
  | { readonly mode: "shared"; readonly listed: boolean };

/** A registered device as `can` sees it for the principal. */
export interface DeviceResource {
  readonly on: "device";
  readonly relation: DeviceRelation;
}

interface DeviceRule {
  readonly personal: "signed-in-here" | "nobody";
  readonly shared: "listed" | "nobody";
}

type DeviceRules = { readonly [A in DeviceAction]: DeviceRule };

const deviceRules: DeviceRules = {
  control: { personal: "signed-in-here", shared: "listed" },
};

const decideDevice = (principal: Principal, rule: DeviceRule, device: DeviceResource): Decision => {
  if (principal.kind === "service") return hidden("service");

  if (principal.role === "guest") return hidden("guest");

  const { relation } = device;

  if (relation.mode === "personal") {
    return rule.personal === "signed-in-here" && relation.signedInHere
      ? ALLOWED
      : hidden("not-signed-in-here");
  }

  return rule.shared === "listed" && relation.listed ? ALLOWED : hidden("unlisted");
};

const isContentAction = (action: string): action is ContentAction =>
  contentActions.some((known) => known === action);

const isAccountAction = (action: string): action is AccountAction =>
  accountActions.some((known) => known === action);

const isServerAction = (action: string): action is ServerAction =>
  serverActions.some((known) => known === action);

const isTileAction = (action: string): action is TileAction =>
  tileActions.some((known) => known === action);

const isApprovalAction = (action: string): action is ApprovalAction =>
  approvalActions.some((known) => known === action);

const isDeviceAction = (action: string): action is DeviceAction =>
  deviceActions.some((known) => known === action);

/**
 * The one access decision (ADR 0005): role, credential scopes, grants, and restrictions, from
 * facts the caller loaded. Content needs a grant, so admins see no one's private things; a
 * missing grant, a restriction, and a service are all `hidden`.
 */
export function can(
  principal: Principal,
  action: ContentAction,
  resource: ContentResource,
): Decision;
export function can(
  principal: Principal,
  action: AccountAction,
  resource: AccountResource,
): Decision;
export function can(principal: Principal, action: ServerAction, resource: ServerResource): Decision;
export function can(principal: Principal, action: TileAction, resource: TileResource): Decision;
export function can(
  principal: Principal,
  action: ApprovalAction,
  resource: ApprovalResource,
): Decision;
export function can(principal: Principal, action: DeviceAction, resource: DeviceResource): Decision;
export function can(
  principal: Principal,
  action: ContentAction | AccountAction | ServerAction | TileAction | ApprovalAction | DeviceAction,
  resource:
    | ContentResource
    | AccountResource
    | ServerResource
    | TileResource
    | ApprovalResource
    | DeviceResource,
): Decision {
  if (resource.on === "content" && isContentAction(action)) {
    return decideContent(principal, action, resource);
  }

  if (resource.on === "account" && isAccountAction(action)) {
    return decideAccount(principal, accountRules[action], resource);
  }

  if (resource.on === "server" && isServerAction(action)) {
    return decideServer(principal, serverRules[action]);
  }

  if (resource.on === "tile" && isTileAction(action)) {
    return decideTile(principal, tileRules[action], resource);
  }

  if (resource.on === "approval" && isApprovalAction(action)) {
    return decideApproval(principal, resource);
  }

  if (resource.on === "device" && isDeviceAction(action)) {
    return decideDevice(principal, deviceRules[action], resource);
  }

  throw new Error(`${action} is not an action on ${resource.on}`);
}

const NO_SCOPES: ReadonlyArray<CredentialScope> = [];

const DOMAIN_SCOPES: ReadonlyArray<CredentialScope> = domainScopes;

const allowedScopes = (user: Doc<"users">): ReadonlyArray<CredentialScope> =>
  user.kind === "service" ? NO_SCOPES : roleScopes[user.role];

/**
 * The scopes a session holds now: a password session holds its role's, a tile on a shared device
 * only its role's content scopes, and an API key or a device sign-in the ones it was given that its
 * role still allows. A service holds none yet.
 */
export const heldScopes = (
  session: Doc<"authSessions">,
  user: Doc<"users">,
): Array<CredentialScope> => {
  const allowed = allowedScopes(user);

  if (session.kind === "password") return [...allowed];

  if (session.kind === "tile") return allowed.filter((scope) => DOMAIN_SCOPES.includes(scope));

  return session.scopes.filter((scope) => allowed.includes(scope));
};

/** A person's restrictions; only a member carries them. */
export const restrictionsOf = (person: PersonDoc): Restrictions | null =>
  person.role === "member" ? (person.restrictions ?? null) : null;

/**
 * The principal a user row stands for, holding `scopes`. Without them it holds what the row alone
 * allows, which is what a link checks of its maker, who has no session in the call.
 */
export const principalOf = (
  user: Doc<"users">,
  scopes: ReadonlyArray<CredentialScope> = allowedScopes(user),
): Principal =>
  user.kind === "service"
    ? { kind: "service", userId: user._id, scopes }
    : {
        kind: "person",
        userId: user._id,
        role: user.role,
        scopes,
        restrictions: restrictionsOf(user),
      };

export const accountTarget = (user: Doc<"users">): AccountResource => ({
  on: "account",
  target:
    user.kind === "service"
      ? { kind: "service", userId: user._id }
      : {
          kind: "person",
          userId: user._id,
          role: user.role,
          restricted: restrictionsOf(user) !== null,
        },
});

/**
 * Whether a role change must end every session and key of the person: the new role lacks a scope
 * the old one held. That covers losing the right to make invites and reset links, so the links
 * the person made stop working too (ADR 0003, ADR 0005).
 */
export const endsCredentials = (from: Role, to: Role): boolean => {
  const held: ReadonlyArray<CredentialScope> = roleScopes[from];
  const kept: ReadonlyArray<CredentialScope> = roleScopes[to];

  return held.some((scope) => !kept.includes(scope));
};

/** A kid: a member an admin restricted. */
export const isKid = (user: Doc<"users">): boolean =>
  user.kind === "person" && restrictionsOf(user) !== null;

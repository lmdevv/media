import { levels } from "../../../commands/access";
import type {
  Level,
  LibraryId,
  ResourceType,
  Restrictions,
  resourceTypes,
} from "../../../commands/access";
import { domainScopes, roleScopes, serviceScopes } from "../../../commands/scopes";
import type {
  ContentDomain,
  ContentVerb,
  CredentialScope,
  Role,
  ServiceScope,
} from "../../../commands/scopes";
import type { Doc, Id } from "../../_generated/dataModel";
import type { JoinSetting, Settings } from "../together/model";

/** A user row that is a person: someone with a role who signs in with a password. */
export type PersonDoc = Extract<Doc<"users">, { readonly kind: "person" }>;

/**
 * Who acts. A person has a role, the scopes their credential holds now, their restrictions, and
 * how they signed in. A service, such as the media server, has no role and no restrictions.
 */
export type Principal =
  | {
      readonly kind: "person";
      readonly userId: Id<"users">;
      readonly role: Role;
      readonly scopes: ReadonlyArray<CredentialScope>;
      readonly restrictions: Restrictions | null;
      /** How this call signed in; null with no session in the call, as for a link's maker. */
      readonly sessionKind: Doc<"authSessions">["kind"] | null;
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
  | "not-signed-in-here"
  | "no-device"
  | "shared-device"
  | "missing"
  | "outside"
  | "ended"
  | "blocked"
  | "join-setting"
  | "pending"
  | "not-host"
  | "no-control"
  | "no-add"
  | "switched-off"
  | "not-allowed"
  | "unbacked"
  | "revoked"
  | "expired"
  | "not-shared"
  | "api-key"
  | "needs-password";

/**
 * An access decision. `hidden` answers as if the thing did not exist, so a private thing stays
 * private from everyone, admins included; `forbidden` refuses something the principal can see.
 */
export type Decision<B extends Because = Because> =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly refusal: "hidden" | "forbidden";
      readonly because: B;
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
  "allowSharing",
] as const;

/** What can be done to the server as a whole. */
export const serverActions = [
  "invite",
  "manageGroups",
  "manageFolders",
  "manageDevices",
  "configureGuests",
] as const;

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
  allowSharing: { scope: "admin", self: "refuse", targets: ["member"], restricted: "any" },
};

const serverRules: ServerRules = {
  invite: { scope: "admin" },
  manageGroups: { scope: "admin" },
  manageFolders: { scope: "admin" },
  manageDevices: { scope: "admin" },
  configureGuests: { scope: "admin" },
};

const ALLOWED = { allowed: true } as const;

const hidden = <B extends Because>(because: B): Decision<B> => ({
  allowed: false,
  refusal: "hidden",
  because,
});

const forbidden = <B extends Because>(because: B): Decision<B> => ({
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

/**
 * What can be done to a registered device through Connect (ADR 0018): `control` its playback, or
 * `report` what it plays from a session on it.
 */
export const deviceActions = ["control", "report"] as const;

export type DeviceAction = (typeof deviceActions)[number];

/** How the principal relates to a device: signed in on a personal one, listed on a shared one. */
export type DeviceRelation =
  | { readonly mode: "personal"; readonly signedInHere: boolean }
  | { readonly mode: "shared"; readonly listed: boolean };

/** The principal's membership in the group session a device plays (ADR 0017). */
export interface SessionMembership {
  /** The session lets this member control playback. */
  readonly control: boolean;
}

/** A registered device as `can` sees it for the principal. */
export interface DeviceResource {
  readonly on: "device";
  readonly relation: DeviceRelation;
  /** The domain the device plays now, or null when it plays nothing. */
  readonly domain: ContentDomain | null;
  /** The principal's membership in the group session the device plays, or null for none. */
  readonly session: SessionMembership | null;
}

interface DeviceRule {
  readonly verb: ContentVerb;
}

type DeviceRules = { readonly [A in DeviceAction]: DeviceRule };

const deviceRules: DeviceRules = {
  control: { verb: "play" },
  report: { verb: "play" },
};

type PersonPrincipal = Extract<Principal, { readonly kind: "person" }>;

const scopeOf = (domain: ContentDomain, verb: ContentVerb): CredentialScope => `${domain}:${verb}`;

const holdsVerb = (
  scopes: ReadonlyArray<CredentialScope>,
  domain: ContentDomain | null,
  verb: ContentVerb,
): boolean =>
  domain === null
    ? domainScopes.some((scope) => scope.endsWith(`:${verb}`) && scopes.includes(scope))
    : scopes.includes(scopeOf(domain, verb));

const reachesDevice = (principal: PersonPrincipal, device: DeviceResource): Decision => {
  if (principal.role === "guest") {
    if (device.session === null) return hidden("guest");

    return device.session.control ? ALLOWED : forbidden("no-control");
  }

  const { relation } = device;

  if (relation.mode === "personal") {
    return relation.signedInHere ? ALLOWED : hidden("not-signed-in-here");
  }

  return relation.listed ? ALLOWED : hidden("unlisted");
};

const decideDevice = (principal: Principal, rule: DeviceRule, device: DeviceResource): Decision => {
  if (principal.kind === "service") return hidden("service");

  const reach = reachesDevice(principal, device);

  if (!reach.allowed) return reach;

  return holdsVerb(principal.scopes, device.domain, rule.verb) ? ALLOWED : forbidden("scope");
};

export const settingActions = ["see", "change"] as const;

export type SettingAction = (typeof settingActions)[number];

/**
 * A setting as `can` sees it: whose value it is, and the domains whose players read it, from the
 * settings table. A per-device value is still one person's, on the device their session is on.
 */
export interface SettingResource {
  readonly on: "setting";
  readonly owner: Id<"users">;
  readonly domains: ReadonlyArray<ContentDomain>;
}

/**
 * Settings are their person's own, so nobody sees or changes anyone else's, admins included.
 * Changing one needs `account` or the `play` scope of a domain that reads it, which a tile on a
 * shared device holds. A restriction never reads one: a preference neither widens nor narrows what
 * a kid sees.
 */
const decideSetting = (
  principal: Principal,
  action: SettingAction,
  setting: SettingResource,
): Decision => {
  if (principal.kind === "service") return hidden("service");

  if (principal.userId !== setting.owner) return hidden("not-yours");

  if (principal.role === "guest") return forbidden("guest");

  if (action === "see") return ALLOWED;

  return principal.scopes.includes("account") ||
    setting.domains.some((domain) => principal.scopes.includes(`${domain}:play`))
    ? ALLOWED
    : forbidden("scope");
};

/** What can be done with a thing kept on a device for offline play (ADR 0019). */
export const downloadActions = ["keep"] as const;

export type DownloadAction = (typeof downloadActions)[number];

/** A registered device's mode. */
export type DeviceMode = Doc<"devices">["mode"];

/**
 * A thing kept on a device, as `can` sees it: the mode of the device the principal's session is on,
 * null for a session on no device, and the thing itself as content, null when no such thing exists.
 */
export interface DownloadResource {
  readonly on: "download";
  readonly device: DeviceMode | null;
  readonly item: ContentResource | null;
}

interface DownloadRule {
  readonly content: ContentAction;
  readonly devices: { readonly [M in DeviceMode]: "keeps" | "keeps-nothing" };
}

type DownloadRules = { readonly [A in DownloadAction]: DownloadRule };

const downloadRules: DownloadRules = {
  keep: { content: "play", devices: { personal: "keeps", shared: "keeps-nothing" } },
};

const decideDownload = (
  principal: Principal,
  rule: DownloadRule,
  download: DownloadResource,
): Decision => {
  if (principal.kind === "service") return hidden("service");

  if (principal.role === "guest") return forbidden("guest");

  if (download.device === null) return forbidden("no-device");

  if (rule.devices[download.device] === "keeps-nothing") return forbidden("shared-device");

  return download.item === null
    ? hidden("missing")
    : decideContent(principal, rule.content, download.item);
};

/**
 * Where the principal stands in a group session: not in it, removed or turned away by its host,
 * waiting for the host, or in it as a guest or as its host. A platform guest in it is a guest.
 */
export type TogetherPlace = "outside" | "blocked" | "pending" | "guest" | "host";

/** A group session as `can` sees it for the principal. */
export interface TogetherResource {
  readonly on: "together";
  readonly domain: ContentDomain;
  /** Null for a session the principal would start, or when they are in none. */
  readonly session: {
    readonly live: boolean;
    readonly place: TogetherPlace;
    readonly settings: Settings;
    /** The principal queued the entry a `remove` names. */
    readonly addedIt: boolean;
    /** The principal is a guest whose share link names this session (ADR 0007). */
    readonly invited: boolean;
  } | null;
}

/**
 * What can be done to a group session. `join` enters it and `ask` waits for its host. `see` reads
 * one's own place in it and keeps one present, pending included; `view` reads its queue. `remove`
 * takes an entry out of its queue. `admit` lets a waiting person in, and `manage` changes its
 * settings and removes people.
 */
export const togetherActions = [
  "start",
  "join",
  "ask",
  "see",
  "view",
  "leave",
  "control",
  "add",
  "remove",
  "admit",
  "manage",
] as const;

export type TogetherAction = (typeof togetherActions)[number];

/** Why `can` refuses something in a group session. */
export type TogetherBecause = Extract<
  Because,
  | "service"
  | "outside"
  | "scope"
  | "guest"
  | "ended"
  | "blocked"
  | "locked"
  | "join-setting"
  | "pending"
  | "not-host"
  | "no-control"
  | "no-add"
  | "not-yours"
>;

interface InsideRule {
  readonly from: "inside";
  /** `member`: waiting or joined. `joined`: in it. `host`: its host. */
  readonly who: "member" | "joined" | "host";
  /** An ended session still allows it. */
  readonly ended: boolean;
  /** A locked session still allows it. */
  readonly locked: boolean;
  /** What a joined guest needs the host to allow. */
  readonly guests: "nothing" | "control" | "add";
  /** A guest does it only to what they queued. */
  readonly own: boolean;
  /** `account` also does instead of the domain's play scope, as for leaving. */
  readonly orAccount: boolean;
  /**
   * A guest a share link let in may do it. Such a guest cannot browse, so they have nothing of their
   * own to queue.
   */
  readonly platformGuests: boolean;
}

type TogetherRule =
  | { readonly from: "new" }
  | { readonly from: "outside"; readonly under: JoinSetting }
  | InsideRule;

type TogetherRules = { readonly [A in TogetherAction]: TogetherRule };

const MEMBER: InsideRule = {
  from: "inside",
  who: "member",
  ended: true,
  locked: true,
  guests: "nothing",
  own: false,
  orAccount: false,
  platformGuests: true,
};

const LIVE: Omit<InsideRule, "who" | "guests"> = {
  from: "inside",
  ended: false,
  locked: true,
  own: false,
  orAccount: false,
  platformGuests: true,
};

const togetherRules: TogetherRules = {
  start: { from: "new" },
  join: { from: "outside", under: "open" },
  ask: { from: "outside", under: "approval" },
  see: MEMBER,
  view: { ...MEMBER, who: "joined" },
  leave: { ...MEMBER, orAccount: true },
  control: { ...LIVE, who: "joined", guests: "control" },
  add: { ...LIVE, who: "joined", guests: "add", platformGuests: false },
  remove: { ...LIVE, who: "joined", guests: "add", own: true, platformGuests: false },
  /** A locked session takes no new members, approved or not. */
  admit: { ...LIVE, who: "host", guests: "nothing", locked: false },
  manage: { ...LIVE, who: "host", guests: "nothing" },
};

type Session = NonNullable<TogetherResource["session"]>;

const enterSession = (
  principal: Extract<Principal, { readonly kind: "person" }>,
  under: JoinSetting,
  session: Session,
): Decision<TogetherBecause> => {
  if (!session.live) return forbidden("ended");

  if (session.place === "host" || session.place === "guest") return ALLOWED;

  if (session.place === "blocked") return forbidden("blocked");

  if (principal.role === "guest" && !session.invited) return forbidden("guest");

  if (session.settings.join === under) return ALLOWED;

  return forbidden(session.settings.join === "locked" ? "locked" : "join-setting");
};

const actInSession = (
  principal: PersonPrincipal,
  rule: InsideRule,
  session: Session,
): Decision<TogetherBecause> => {
  const { place, settings } = session;

  if (!session.live && !rule.ended) return forbidden("ended");

  if (principal.role === "guest" && !rule.platformGuests) return forbidden("guest");

  if (place === "pending") return rule.who === "member" ? ALLOWED : forbidden("pending");

  if (rule.who === "host" && place !== "host") return forbidden("not-host");

  if (!rule.locked && settings.join === "locked") return forbidden("locked");

  if (place === "host" || rule.guests === "nothing") return ALLOWED;

  if (rule.guests === "control" && !settings.control) return forbidden("no-control");

  if (rule.guests === "add" && !settings.add) return forbidden("no-add");

  return rule.own && !session.addedIt ? forbidden("not-yours") : ALLOWED;
};

const decideTogether = (
  principal: Principal,
  rule: TogetherRule,
  { domain, session }: TogetherResource,
): Decision<TogetherBecause> => {
  if (principal.kind === "service") return hidden("service");

  const outside = session === null || session.place === "outside" || session.place === "blocked";

  if (rule.from === "inside" && outside) return hidden("outside");

  const viaAccount =
    rule.from === "inside" && rule.orAccount && principal.scopes.includes("account");

  if (!viaAccount && !principal.scopes.includes(`${domain}:play`)) return forbidden("scope");

  if (rule.from === "new") return principal.role === "guest" ? forbidden("guest") : ALLOWED;

  if (session === null) return hidden("outside");

  return rule.from === "outside"
    ? enterSession(principal, rule.under, session)
    : actInSession(principal, rule, session);
};

const shareRoles = {
  owner: "always",
  admin: "always",
  member: "when-allowed",
  guest: "never",
} as const satisfies { readonly [R in Role]: "always" | "when-allowed" | "never" };

/** The maker of a share link as `can` sees it. */
export interface ShareMaker {
  /**
   * Making a link: the caller, with the scopes their session holds. Otherwise what the maker's row
   * alone allows, since the maker has no session in the call.
   */
  readonly principal: PersonPrincipal;
  /** An admin allowed this member to make guest links; owners and admins need no such allowance. */
  readonly allowed: boolean;
  /** The maker's session generation still matches the link's stamp; true for a link being made. */
  readonly backs: boolean;
}

/** What a link names, as its maker reaches it now. */
export type ShareTargetFacts =
  | { readonly kind: "item"; readonly content: ContentResource | null }
  /** The group session, with the maker's place in it. */
  | { readonly kind: "session"; readonly session: TogetherResource };

/** Where a guest sits in the group session their link names. */
export interface ShareSeat {
  readonly place: TogetherPlace;
  readonly live: boolean;
}

/**
 * What a share action is about, beyond the link itself. `standing`: nothing. `target`: what the
 * link names. `item`: one item a guest asks to play, whether the link covers it, the item as the
 * maker sees it (null when it does not exist), and for a session link where the guest sits.
 */
export type ShareAbout =
  | { readonly kind: "standing" }
  | { readonly kind: "target"; readonly target: ShareTargetFacts }
  | {
      readonly kind: "item";
      readonly covered: boolean;
      readonly content: ContentResource | null;
      readonly seat: ShareSeat | null;
    };

/** A share link as `can` sees it, made of facts `core/guests/facts.ts` loads. */
export interface ShareResource {
  readonly on: "share";
  /** Guest links are on, and have stayed on since the link was made; a new link always has. */
  readonly switchedOn: boolean;
  readonly maker: ShareMaker;
  /** `new` while the link is being made; `mine` when the principal is a guest it let in. */
  readonly link: "new" | { readonly state: "open" | "revoked" | "expired"; readonly mine: boolean };
  readonly about: ShareAbout;
}

/**
 * What can be done through a share link. `offer` asks whether the caller may make links at all,
 * and `make` makes one; neither is open to an API key. `open` lets a new guest in, `hold` keeps a
 * guest's session live on every call, and `play` plays one item.
 */
export const shareActions = ["offer", "make", "open", "hold", "play"] as const;

export type ShareAction = (typeof shareActions)[number];

interface ShareRule {
  readonly by: "maker" | "guest";
  readonly about: ShareAbout["kind"];
}

type ShareRules = { readonly [A in ShareAction]: ShareRule };

const shareRules: ShareRules = {
  offer: { by: "maker", about: "standing" },
  make: { by: "maker", about: "target" },
  open: { by: "guest", about: "target" },
  hold: { by: "guest", about: "standing" },
  play: { by: "guest", about: "item" },
};

/**
 * Whether a link stands: guest links on since it was made, its maker still may and still backs it,
 * and it is open. Every share decision starts here; a list shows it as the link's state.
 */
export const linkStanding = (share: Omit<ShareResource, "about">): Decision => {
  if (!share.switchedOn) return forbidden("switched-off");

  const may = shareRoles[share.maker.principal.role];

  if (may === "never" || (may === "when-allowed" && !share.maker.allowed)) {
    return forbidden("not-allowed");
  }

  if (!share.maker.backs) return forbidden("unbacked");

  return share.link !== "new" && share.link.state !== "open"
    ? forbidden(share.link.state)
    : ALLOWED;
};

const reachesTarget = (maker: PersonPrincipal, target: ShareTargetFacts): Decision => {
  if (target.kind === "session") return decideTogether(maker, togetherRules.manage, target.session);

  return target.content === null ? hidden("missing") : decideContent(maker, "play", target.content);
};

const playsItem = (
  guest: PersonPrincipal,
  maker: PersonPrincipal,
  asked: Extract<ShareAbout, { readonly kind: "item" }>,
): Decision => {
  const { content, seat } = asked;

  if (!asked.covered || content === null) return hidden("not-shared");

  if (seat !== null) {
    if (!seat.live) return forbidden("ended");

    if (seat.place === "pending") return forbidden("pending");

    if (seat.place !== "guest") return hidden("outside");
  }

  if (!guest.scopes.includes(`${content.domain}:play`)) return forbidden("scope");

  return decideContent(maker, "play", content);
};

const decideShare = (principal: Principal, rule: ShareRule, share: ShareResource): Decision => {
  if (principal.kind === "service") return hidden("service");

  const { about, link, maker } = share;

  if (rule.about !== about.kind) {
    throw new Error(`A share link's ${about.kind} facts cannot decide ${rule.about}`);
  }

  if (rule.by === "maker") {
    if (principal.role === "guest") return forbidden("guest");

    if (link !== "new" || principal.userId !== maker.principal.userId) {
      throw new Error("Making a link decides a new link for its own maker");
    }

    if (!principal.scopes.includes("account")) return forbidden("scope");

    if (principal.sessionKind === "apiKey") return forbidden("api-key");
  } else if (principal.role !== "guest" || link === "new" || !link.mine) {
    return hidden("not-yours");
  }

  const stands = linkStanding(share);

  if (!stands.allowed || about.kind === "standing") return stands;

  return about.kind === "target"
    ? reachesTarget(maker.principal, about.target)
    : playsItem(principal, maker.principal, about);
};

/** What can be done to a link as a record: read its activity, revoke it, or see what it names. */
export const shareRecordActions = ["audit", "revoke", "see"] as const;

export type ShareRecordAction = (typeof shareRecordActions)[number];

/** A link as a record: its maker, or null for every link at once, as listing everyone's asks. */
export interface ShareRecordResource {
  readonly on: "shareRecord";
  readonly maker: Id<"users"> | null;
}

interface ShareRecordRule {
  /** Who may do it to someone else's links. Nobody sees another person's content, admins included. */
  readonly others: "admin" | "nobody";
}

type ShareRecordRules = { readonly [A in ShareRecordAction]: ShareRecordRule };

const shareRecordRules: ShareRecordRules = {
  audit: { others: "admin" },
  revoke: { others: "admin" },
  see: { others: "nobody" },
};

const decideShareRecord = (
  principal: Principal,
  rule: ShareRecordRule,
  record: ShareRecordResource,
): Decision => {
  if (principal.kind === "service") return hidden("service");

  if (principal.role === "guest") return hidden("guest");

  if (record.maker === principal.userId) {
    return principal.scopes.includes("account") ? ALLOWED : forbidden("scope");
  }

  return rule.others === "admin" && principal.scopes.includes("admin")
    ? ALLOWED
    : hidden("not-yours");
};

/**
 * What can be done with a device grant (D48, ADR 0006). `issue` makes or confirms the grant of
 * the device the caller signs in on, `list` shows the caller's grants, and `revoke` ends one.
 */
export const grantActions = ["issue", "list", "revoke"] as const;

export type GrantAction = (typeof grantActions)[number];

/** A device grant as `can` sees it: whose it is, or whose it will be while it is being issued. */
export interface GrantResource {
  readonly on: "deviceGrant";
  readonly owner: Id<"users">;
}

interface GrantRule {
  /**
   * `password`: only a session a password opened, so no grant, key, or device sign-in mints a
   * grant that outlives it. `any`: any session with `account`.
   */
  readonly session: "password" | "any";
}

type GrantRules = { readonly [A in GrantAction]: GrantRule };

const grantRules: GrantRules = {
  issue: { session: "password" },
  list: { session: "any" },
  revoke: { session: "any" },
};

/** A grant is its person's own: nobody else lists or revokes it, admins included. */
const decideGrant = (principal: Principal, rule: GrantRule, grant: GrantResource): Decision => {
  if (principal.kind === "service") return hidden("service");

  if (principal.userId !== grant.owner) return hidden("not-yours");

  if (principal.role === "guest") return forbidden("guest");

  if (!principal.scopes.includes("account")) return forbidden("scope");

  if (rule.session === "password" && principal.sessionKind !== "password") {
    return forbidden(principal.sessionKind === "apiKey" ? "api-key" : "needs-password");
  }

  return ALLOWED;
};

/**
 * What can be done with a person's own sign-in credentials: their sessions and their API keys.
 * `list` shows them, never a secret, and `end` signs one out or revokes it.
 */
export const credentialActions = ["list", "end"] as const;

export type CredentialAction = (typeof credentialActions)[number];

/** A session or an API key as `can` sees it: whose it is. */
export interface CredentialResource {
  readonly on: "credential";
  readonly owner: Id<"users">;
}

/**
 * A credential is its person's own: nobody else lists or ends it, admins included, and an admin
 * signs someone out everywhere through their account instead. Any session holding `account` may,
 * as old movies let an account-scoped session list and sign out the account's sessions and keys.
 */
const decideCredential = (principal: Principal, credential: CredentialResource): Decision => {
  if (principal.kind === "service") return hidden("service");

  if (principal.userId !== credential.owner) return hidden("not-yours");

  if (principal.role === "guest") return forbidden("guest");

  return principal.scopes.includes("account") ? ALLOWED : forbidden("scope");
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

const isSettingAction = (action: string): action is SettingAction =>
  settingActions.some((known) => known === action);

const isDownloadAction = (action: string): action is DownloadAction =>
  downloadActions.some((known) => known === action);

const isTogetherAction = (action: string): action is TogetherAction =>
  togetherActions.some((known) => known === action);

const isShareAction = (action: string): action is ShareAction =>
  shareActions.some((known) => known === action);

const isShareRecordAction = (action: string): action is ShareRecordAction =>
  shareRecordActions.some((known) => known === action);

const isGrantAction = (action: string): action is GrantAction =>
  grantActions.some((known) => known === action);

const isCredentialAction = (action: string): action is CredentialAction =>
  credentialActions.some((known) => known === action);

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
  action: SettingAction,
  resource: SettingResource,
): Decision;
export function can(
  principal: Principal,
  action: DownloadAction,
  resource: DownloadResource,
): Decision;
export function can(
  principal: Principal,
  action: TogetherAction,
  resource: TogetherResource,
): Decision<TogetherBecause>;
export function can(principal: Principal, action: ShareAction, resource: ShareResource): Decision;
export function can(
  principal: Principal,
  action: ShareRecordAction,
  resource: ShareRecordResource,
): Decision;
export function can(principal: Principal, action: GrantAction, resource: GrantResource): Decision;
export function can(
  principal: Principal,
  action: CredentialAction,
  resource: CredentialResource,
): Decision;
export function can(
  principal: Principal,
  action:
    | ContentAction
    | AccountAction
    | ServerAction
    | TileAction
    | ApprovalAction
    | DeviceAction
    | SettingAction
    | DownloadAction
    | TogetherAction
    | ShareAction
    | ShareRecordAction
    | GrantAction
    | CredentialAction,
  resource:
    | ContentResource
    | AccountResource
    | ServerResource
    | TileResource
    | ApprovalResource
    | DeviceResource
    | SettingResource
    | DownloadResource
    | TogetherResource
    | ShareResource
    | ShareRecordResource
    | GrantResource
    | CredentialResource,
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

  if (resource.on === "setting" && isSettingAction(action)) {
    return decideSetting(principal, action, resource);
  }

  if (resource.on === "download" && isDownloadAction(action)) {
    return decideDownload(principal, downloadRules[action], resource);
  }

  if (resource.on === "together" && isTogetherAction(action)) {
    return decideTogether(principal, togetherRules[action], resource);
  }

  if (resource.on === "share" && isShareAction(action)) {
    return decideShare(principal, shareRules[action], resource);
  }

  if (resource.on === "shareRecord" && isShareRecordAction(action)) {
    return decideShareRecord(principal, shareRecordRules[action], resource);
  }

  if (resource.on === "deviceGrant" && isGrantAction(action)) {
    return decideGrant(principal, grantRules[action], resource);
  }

  if (resource.on === "credential" && isCredentialAction(action)) {
    return decideCredential(principal, resource);
  }

  throw new Error(`${action} is not an action on ${resource.on}`);
}

const NO_SCOPES: ReadonlyArray<CredentialScope> = [];

const DOMAIN_SCOPES: ReadonlyArray<CredentialScope> = domainScopes;

const allowedScopes = (user: Doc<"users">): ReadonlyArray<CredentialScope> =>
  user.kind === "service" ? NO_SCOPES : roleScopes[user.role];

/**
 * The credential scopes a session holds now: a password, device grant, or guest session holds its
 * role's, a tile on a shared device only its role's content scopes, and an API key or a device
 * sign-in the ones it was given that its role still allows. A service holds none.
 */
export const heldScopes = (
  session: Doc<"authSessions">,
  user: Doc<"users">,
): Array<CredentialScope> => {
  const allowed = allowedScopes(user);

  if (session.kind === "password" || session.kind === "grant") return [...allowed];

  if (session.kind === "tile") return allowed.filter((scope) => DOMAIN_SCOPES.includes(scope));

  if (session.kind === "guest") return [...allowed];

  return session.scopes.flatMap((scope) => allowed.filter((held) => held === scope));
};

/**
 * The service scopes a session holds now: the ones its API key was issued with when the session is
 * a service's, and none for anyone else. No role allows a service scope, so a person never holds
 * one.
 */
export const heldServiceScopes = (
  session: Doc<"authSessions">,
  user: Doc<"users">,
): Array<ServiceScope> =>
  user.kind === "service" && session.kind === "apiKey"
    ? session.scopes.flatMap((scope) => serviceScopes.filter((held) => held === scope))
    : [];

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
        sessionKind: null,
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
